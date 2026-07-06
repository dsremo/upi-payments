const PAYMENT_TTL_SECONDS = 600;

const ALLOWED_TRANSITIONS = {
  created: ["pending", "failed", "expired"],
  pending: ["success", "failed", "expired"],
  success: [],
  failed: [],
  expired: [],
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    if (method === "GET" && (path === "/favicon.svg" || path === "/favicon.ico")) {
      const faviconSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64"><rect width="64" height="64" rx="14" fill="#2f81f7"/><text x="32" y="34" font-family="Arial,sans-serif" font-weight="700" font-size="38" fill="#fff" text-anchor="middle" dominant-baseline="central">₹</text></svg>`;
      return new Response(faviconSvg, { headers: { "content-type": "image/svg+xml", "cache-control": "public, max-age=86400" } });
    }
    if (method === "GET" && path === "/robots.txt") {
      return new Response("User-agent: *\nAllow: /\nSitemap: https://pay.dsremo.com/sitemap.xml\n", { headers: { "content-type": "text/plain; charset=utf-8" } });
    }
    if (method === "GET" && path === "/sitemap.xml") {
      return new Response('<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n<url><loc>https://pay.dsremo.com/</loc><changefreq>monthly</changefreq><priority>1.0</priority></url>\n<url><loc>https://pay.dsremo.com/checkout</loc><changefreq>monthly</changefreq><priority>0.8</priority></url>\n</urlset>\n', { headers: { "content-type": "application/xml; charset=utf-8" } });
    }

    try {
      if (method === "GET" && path === "/") {
        return new Response(LANDING_HTML, { headers: { "content-type": "text/html; charset=utf-8" } });
      }
      if (method === "GET" && path === "/checkout") {
        return new Response(CHECKOUT_HTML, { headers: { "content-type": "text/html; charset=utf-8" } });
      }
      if (method === "GET" && path === "/api") return json(apiInfo());
      if (method === "GET" && path === "/api/health") return json({ ok: true });
      if (method === "POST" && path === "/api/payments") return createPayment(request, env);
      if (method === "POST" && path === "/api/verify-payment") return verifyPayment(request, env);
      if (method === "POST" && path === "/api/webhook") return handleWebhook(request, env);

      const statusMatch = path.match(/^\/api\/payments\/([A-Za-z0-9_]+)$/);
      if (method === "GET" && statusMatch) return getPaymentStatus(statusMatch[1], env);

      const mockMatch = path.match(/^\/api\/payments\/([A-Za-z0-9_]+)\/mock\/(approve|decline)$/);
      if (method === "POST" && mockMatch) return mockAction(mockMatch[1], mockMatch[2], env);

      const refundMatch = path.match(/^\/api\/payments\/([A-Za-z0-9_]+)\/refund$/);
      if (method === "POST" && refundMatch) return createRefund(refundMatch[1], request, env);

      const refundStatusMatch = path.match(/^\/api\/refunds\/([A-Za-z0-9_]+)$/);
      if (method === "GET" && refundStatusMatch) return getRefund(refundStatusMatch[1], env);

      return json({ error: "not_found" }, 404);
    } catch (failure) {
      return json({ error: "internal_error", detail: String(failure && failure.message || failure) }, 500);
    }
  },
};

function razorpayEnabled(env) {
  return Boolean(env.RAZORPAY_KEY_ID && env.RAZORPAY_KEY_SECRET);
}

async function createPayment(request, env) {
  let body;
  try {
    body = await request.json();
  } catch (parseFailure) {
    return json({ error: "invalid_json" }, 400);
  }

  const amount = body.amount;
  if (!Number.isInteger(amount) || amount <= 0) {
    return json({ error: "invalid_amount", detail: "amount must be a positive integer in paise" }, 400);
  }

  const idempotencyKey = request.headers.get("Idempotency-Key") || null;
  if (idempotencyKey) {
    const existing = await env.DB
      .prepare("SELECT * FROM payments WHERE idempotency_key = ?")
      .bind(idempotencyKey)
      .first();
    if (existing) return json(serializePayment(existing, env), 200);
  }

  const currency = body.currency || "INR";
  const payerVpa = body.vpa || null;
  const orderId = body.order_id || null;
  const metadata = body.metadata ? JSON.stringify(body.metadata) : null;
  const provider = razorpayEnabled(env) ? "razorpay" : "mock";
  const paymentId = "pay_" + crypto.randomUUID().replace(/-/g, "");
  const timestamp = new Date().toISOString();

  await env.DB
    .prepare(
      "INSERT INTO payments (id, created_at, updated_at, amount, currency, vpa, status, provider, provider_ref, order_id, idempotency_key, metadata) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)"
    )
    .bind(paymentId, timestamp, timestamp, amount, currency, payerVpa, "created", provider, null, orderId, idempotencyKey, metadata)
    .run();
  await logEvent(env, paymentId, "payment.created", { amount, currency, vpa: payerVpa, provider });

  if (provider === "razorpay") {
    const order = await createRazorpayOrder(env, amount, currency, paymentId);
    await env.DB.prepare("UPDATE payments SET provider_ref = ? WHERE id = ?").bind(order.id, paymentId).run();
    await transition(env, paymentId, "created", "pending", "razorpay.order.created", { order_id: order.id });
  } else {
    await transition(env, paymentId, "created", "pending", "collect.sent", {
      vpa: payerVpa,
      note: "mock UPI collect request dispatched to payer",
    });
  }

  const payment = await loadPayment(env, paymentId);
  return json(serializePayment(payment, env), 201);
}

async function getPaymentStatus(paymentId, env) {
  let payment = await loadPaymentWithExpiry(env, paymentId);
  if (!payment) return json({ error: "not_found" }, 404);

  if (payment.provider === "razorpay" && payment.status === "pending" && razorpayEnabled(env)) {
    payment = await reconcileRazorpay(env, payment);
  }

  const events = await env.DB
    .prepare("SELECT type, at, data FROM payment_events WHERE payment_id = ? ORDER BY id")
    .bind(paymentId)
    .all();

  const refunds = await env.DB
    .prepare("SELECT * FROM refunds WHERE payment_id = ? ORDER BY created_at")
    .bind(paymentId)
    .all();

  const result = serializePayment(payment, env);
  result.events = (events.results || []).map((eventRow) => ({
    type: eventRow.type,
    at: eventRow.at,
    data: eventRow.data ? JSON.parse(eventRow.data) : null,
  }));
  result.refunds = (refunds.results || []).map(serializeRefundRow);
  return json(result);
}

async function mockAction(paymentId, action, env) {
  const payment = await loadPaymentWithExpiry(env, paymentId);
  if (!payment) return json({ error: "not_found" }, 404);
  if (payment.provider !== "mock") {
    return json({ error: "unsupported", detail: "mock actions apply only to mock-provider payments" }, 400);
  }
  if (payment.status !== "pending") {
    return json({ error: "invalid_state", detail: `cannot ${action} a payment in status '${payment.status}'` }, 409);
  }

  const nextStatus = action === "approve" ? "success" : "failed";
  const eventType = action === "approve" ? "payment.success" : "payment.failed";
  await transition(env, paymentId, "pending", nextStatus, eventType, { via: "mock_payer_action" });

  return json(serializePayment(await loadPayment(env, paymentId), env));
}

async function createRefund(paymentId, request, env) {
  const payment = await loadPayment(env, paymentId);
  if (!payment) return json({ error: "not_found" }, 404);
  if (payment.status !== "success") {
    return json({ error: "invalid_state", detail: `only successful payments can be refunded (status '${payment.status}')` }, 409);
  }

  let body = {};
  try {
    body = await request.json();
  } catch (parseFailure) {
    body = {};
  }

  const alreadyRefunded = payment.refunded_amount || 0;
  const refundable = payment.amount - alreadyRefunded;
  const amount = body.amount != null ? body.amount : refundable;
  const reason = body.reason || null;

  if (!Number.isInteger(amount) || amount <= 0) {
    return json({ error: "invalid_amount", detail: "refund amount must be a positive integer in paise" }, 400);
  }
  if (amount > refundable) {
    return json({ error: "amount_exceeds_refundable", detail: `refundable is ${refundable} paise` }, 400);
  }

  const refundId = "rfnd_" + crypto.randomUUID().replace(/-/g, "");
  const timestamp = new Date().toISOString();
  await env.DB
    .prepare("INSERT INTO refunds (id, payment_id, created_at, updated_at, amount, status, provider_ref, reason) VALUES (?,?,?,?,?,?,?,?)")
    .bind(refundId, paymentId, timestamp, timestamp, amount, "processing", null, reason)
    .run();
  await logEvent(env, paymentId, "refund.created", { refund_id: refundId, amount });

  let gatewayRefundRef = null;
  try {
    if (payment.provider === "razorpay") {
      if (!payment.provider_payment_ref) {
        await failRefund(env, refundId, paymentId, "gateway payment id not captured");
        return json({ error: "not_refundable", detail: "gateway payment id not captured; verify the payment first" }, 409);
      }
      const refund = await createRazorpayRefund(env, payment.provider_payment_ref, amount);
      gatewayRefundRef = refund.id;
    }
  } catch (gatewayFailure) {
    await failRefund(env, refundId, paymentId, String(gatewayFailure && gatewayFailure.message || gatewayFailure));
    return json({ error: "gateway_refund_failed" }, 502);
  }

  const bump = await env.DB
    .prepare("UPDATE payments SET refunded_amount = refunded_amount + ?, updated_at = ? WHERE id = ? AND refunded_amount + ? <= amount")
    .bind(amount, timestamp, paymentId, amount)
    .run();
  if (!bump.meta || bump.meta.changes === 0) {
    await failRefund(env, refundId, paymentId, "refundable amount changed (concurrent refund)");
    return json({ error: "refund_race", detail: "refundable amount changed; retry" }, 409);
  }

  await env.DB
    .prepare("UPDATE refunds SET status = 'processed', provider_ref = ?, updated_at = ? WHERE id = ?")
    .bind(gatewayRefundRef, new Date().toISOString(), refundId)
    .run();
  await logEvent(env, paymentId, "refund.processed", { refund_id: refundId, amount, gateway_refund: gatewayRefundRef });

  return json(await serializeRefund(env, refundId), 201);
}

async function failRefund(env, refundId, paymentId, reason) {
  await env.DB
    .prepare("UPDATE refunds SET status = 'failed', updated_at = ? WHERE id = ?")
    .bind(new Date().toISOString(), refundId)
    .run();
  await logEvent(env, paymentId, "refund.failed", { refund_id: refundId, reason });
}

async function createRazorpayRefund(env, razorpayPaymentId, amount) {
  const auth = btoa(`${env.RAZORPAY_KEY_ID}:${env.RAZORPAY_KEY_SECRET}`);
  const response = await fetch(`https://api.razorpay.com/v1/payments/${razorpayPaymentId}/refund`, {
    method: "POST",
    headers: { Authorization: `Basic ${auth}`, "content-type": "application/json" },
    body: JSON.stringify({ amount }),
  });
  if (!response.ok) {
    throw new Error(`razorpay refund failed (${response.status})`);
  }
  return response.json();
}

async function getRefund(refundId, env) {
  const refund = await env.DB.prepare("SELECT * FROM refunds WHERE id = ?").bind(refundId).first();
  if (!refund) return json({ error: "not_found" }, 404);
  return json(serializeRefundRow(refund));
}

async function serializeRefund(env, refundId) {
  const refund = await env.DB.prepare("SELECT * FROM refunds WHERE id = ?").bind(refundId).first();
  return serializeRefundRow(refund);
}

function serializeRefundRow(row) {
  return {
    id: row.id,
    payment_id: row.payment_id,
    amount: row.amount,
    status: row.status,
    provider_ref: row.provider_ref,
    reason: row.reason,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

async function verifyPayment(request, env) {
  let body;
  try {
    body = await request.json();
  } catch (parseFailure) {
    return json({ error: "invalid_json" }, 400);
  }

  const orderRef = body.razorpay_order_id;
  const razorpayPaymentId = body.razorpay_payment_id;
  const signature = body.razorpay_signature;
  if (!orderRef || !razorpayPaymentId || !signature) {
    return json({ verified: false, error: "missing_fields" }, 400);
  }
  if (!env.RAZORPAY_KEY_SECRET) {
    return json({ verified: false, error: "not_configured" }, 503);
  }

  const expected = await hmacSha256Hex(env.RAZORPAY_KEY_SECRET, `${orderRef}|${razorpayPaymentId}`);
  if (!timingSafeEqual(expected, signature)) {
    return json({ verified: false, error: "signature_mismatch" }, 400);
  }

  const payment = await env.DB.prepare("SELECT * FROM payments WHERE provider_ref = ?").bind(orderRef).first();
  if (!payment) {
    return json({ verified: true, note: "signature valid but no matching local payment" });
  }
  await env.DB.prepare("UPDATE payments SET provider_payment_ref = ? WHERE id = ?").bind(razorpayPaymentId, payment.id).run();
  await logEvent(env, payment.id, "checkout.verified", { razorpay_payment_id: razorpayPaymentId });
  if (payment.status === "pending") {
    await transition(env, payment.id, "pending", "success", "payment.success", { via: "checkout_signature" });
  }
  return json({ verified: true, status: "success", id: payment.id });
}

async function handleWebhook(request, env) {
  const rawBody = await request.text();
  const signature = request.headers.get("x-razorpay-signature") || request.headers.get("x-signature") || "";
  const webhookSecret = env.RAZORPAY_WEBHOOK_SECRET;
  if (!webhookSecret) return json({ error: "webhook_not_configured", detail: "set RAZORPAY_WEBHOOK_SECRET" }, 503);

  const expected = await hmacSha256Hex(webhookSecret, rawBody);
  if (!timingSafeEqual(expected, signature)) {
    return json({ error: "invalid_signature" }, 401);
  }

  let event;
  try {
    event = JSON.parse(rawBody);
  } catch (parseFailure) {
    return json({ error: "invalid_json" }, 400);
  }

  const eventType = event.event || "unknown";
  const entity = event.payload && event.payload.payment && event.payload.payment.entity;
  const orderRef = entity && entity.order_id;
  if (!orderRef) return json({ received: true, note: "no order_id in payload; ignored" });

  const payment = await env.DB.prepare("SELECT * FROM payments WHERE provider_ref = ?").bind(orderRef).first();
  if (!payment) return json({ received: true, note: "no matching payment; ignored" });

  await env.DB.prepare("UPDATE payments SET provider_payment_ref = ? WHERE id = ? AND provider_payment_ref IS NULL").bind(entity.id, payment.id).run();
  await logEvent(env, payment.id, "webhook." + eventType, { razorpay_payment_id: entity.id });

  if (payment.status === "pending") {
    if (eventType === "payment.captured") {
      await transition(env, payment.id, "pending", "success", "payment.success", { via: "razorpay_webhook" });
    } else if (eventType === "payment.failed") {
      await transition(env, payment.id, "pending", "failed", "payment.failed", { via: "razorpay_webhook" });
    }
  }

  return json({ received: true });
}

async function createRazorpayOrder(env, amount, currency, receipt) {
  const auth = btoa(`${env.RAZORPAY_KEY_ID}:${env.RAZORPAY_KEY_SECRET}`);
  const response = await fetch("https://api.razorpay.com/v1/orders", {
    method: "POST",
    headers: { Authorization: `Basic ${auth}`, "content-type": "application/json" },
    body: JSON.stringify({ amount, currency, receipt, payment_capture: 1 }),
  });
  if (!response.ok) {
    throw new Error(`razorpay order creation failed (${response.status})`);
  }
  return response.json();
}

async function reconcileRazorpay(env, payment) {
  const auth = btoa(`${env.RAZORPAY_KEY_ID}:${env.RAZORPAY_KEY_SECRET}`);
  const response = await fetch(`https://api.razorpay.com/v1/orders/${payment.provider_ref}/payments`, {
    headers: { Authorization: `Basic ${auth}` },
  });
  if (!response.ok) return payment;
  const data = await response.json();
  const captured = (data.items || []).find((item) => item.status === "captured");
  const failed = (data.items || []).find((item) => item.status === "failed");
  if (captured) {
    await transition(env, payment.id, "pending", "success", "payment.success", { via: "reconcile" });
    return loadPayment(env, payment.id);
  }
  if (failed && !(data.items || []).some((item) => item.status === "captured" || item.status === "created")) {
    await transition(env, payment.id, "pending", "failed", "payment.failed", { via: "reconcile" });
    return loadPayment(env, payment.id);
  }
  return payment;
}

async function transition(env, paymentId, fromStatus, toStatus, eventType, eventData) {
  const allowed = ALLOWED_TRANSITIONS[fromStatus];
  if (!allowed || !allowed.includes(toStatus)) {
    throw new Error(`illegal transition ${fromStatus} -> ${toStatus}`);
  }
  const timestamp = new Date().toISOString();
  const update = await env.DB
    .prepare("UPDATE payments SET status = ?, updated_at = ? WHERE id = ? AND status = ?")
    .bind(toStatus, timestamp, paymentId, fromStatus)
    .run();
  if (!update.meta || update.meta.changes === 0) {
    throw new Error(`transition lost a race for ${paymentId} (${fromStatus} -> ${toStatus})`);
  }
  await logEvent(env, paymentId, eventType, eventData);
}

async function loadPayment(env, paymentId) {
  return env.DB.prepare("SELECT * FROM payments WHERE id = ?").bind(paymentId).first();
}

async function loadPaymentWithExpiry(env, paymentId) {
  const payment = await loadPayment(env, paymentId);
  if (!payment) return null;
  if (payment.status === "created" || payment.status === "pending") {
    const ageSeconds = (Date.now() - Date.parse(payment.created_at)) / 1000;
    if (ageSeconds > PAYMENT_TTL_SECONDS) {
      await transition(env, paymentId, payment.status, "expired", "payment.expired", {
        ttl_seconds: PAYMENT_TTL_SECONDS,
      });
      return loadPayment(env, paymentId);
    }
  }
  return payment;
}

async function logEvent(env, paymentId, type, data) {
  await env.DB
    .prepare("INSERT INTO payment_events (payment_id, at, type, data) VALUES (?,?,?,?)")
    .bind(paymentId, new Date().toISOString(), type, data ? JSON.stringify(data) : null)
    .run();
}

async function hmacSha256Hex(secret, message) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return [...new Uint8Array(signature)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function timingSafeEqual(expected, given) {
  if (typeof expected !== "string" || typeof given !== "string" || expected.length !== given.length) {
    return false;
  }
  let mismatch = 0;
  for (let index = 0; index < expected.length; index += 1) {
    mismatch |= expected.charCodeAt(index) ^ given.charCodeAt(index);
  }
  return mismatch === 0;
}

function serializePayment(row, env) {
  const result = {
    id: row.id,
    status: row.status,
    amount: row.amount,
    currency: row.currency,
    vpa: row.vpa,
    provider: row.provider,
    order_id: row.order_id,
    created_at: row.created_at,
    updated_at: row.updated_at,
    metadata: row.metadata ? JSON.parse(row.metadata) : null,
    refunded_amount: row.refunded_amount || 0,
    refundable_amount: row.status === "success" ? row.amount - (row.refunded_amount || 0) : 0,
  };
  if (row.provider === "razorpay" && row.provider_ref) {
    result.checkout = { razorpay_order_id: row.provider_ref, razorpay_key_id: env.RAZORPAY_KEY_ID || null };
  }
  return result;
}

function apiInfo() {
  return {
    service: "upi-payments",
    endpoints: {
      "POST /api/payments": "create a payment (send Idempotency-Key header to dedupe)",
      "GET /api/payments/:id": "payment status + event history",
      "POST /api/payments/:id/mock/approve": "mock payer approves the UPI collect (mock provider only)",
      "POST /api/payments/:id/mock/decline": "mock payer declines the UPI collect (mock provider only)",
      "POST /api/payments/:id/refund": "full or partial refund (body { amount?, reason? }; defaults to full)",
      "GET /api/refunds/:id": "refund status",
      "POST /api/webhook": "gateway webhook (HMAC-SHA256 signature verified)",
    },
  };
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

const LANDING_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Payment Orchestrator — pay.dsremo.com</title>
<meta name="description" content="A production-shaped payment orchestration service — idempotent API, an enforced state machine, HMAC signature verification, refunds, and signed webhooks. Live checkout demo + API.">
<link rel="canonical" href="https://pay.dsremo.com/">
<meta name="robots" content="index, follow">
<meta name="theme-color" content="#2f81f7">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Payment Orchestrator">
<meta property="og:title" content="Payment Orchestrator — pay.dsremo.com">
<meta property="og:description" content="A production-shaped payment orchestration service — idempotent API, enforced state machine, HMAC verification, refunds, and signed webhooks.">
<meta property="og:url" content="https://pay.dsremo.com/">
<meta property="og:image" content="https://dsremo.com/og/pay.png">
<meta name="twitter:card" content="summary_large_image">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="icon" href="/favicon.ico" sizes="any">
<link rel="apple-touch-icon" href="/favicon.svg">
<style>
  :root{--bg:#0d1117;--card:#161b22;--line:#30363d;--ink:#e6edf3;--mut:#8b949e;--accent:#2f81f7;--good:#3fb950}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--ink);font-family:system-ui,-apple-system,sans-serif;line-height:1.6}
  .wrap{max-width:760px;margin:0 auto;padding:54px 24px 72px}
  .live{display:inline-flex;align-items:center;gap:8px;font-size:12px;color:var(--good);font-family:ui-monospace,Menlo,monospace;letter-spacing:.06em;text-transform:uppercase}
  .live .dot{width:8px;height:8px;border-radius:50%;background:var(--good);box-shadow:0 0 0 3px rgba(63,185,80,.18)}
  h1{font-size:clamp(28px,5vw,36px);margin:14px 0 8px;letter-spacing:-.02em}
  .sub{color:var(--mut);font-size:17px;margin:0 0 28px;max-width:62ch}
  .cta{display:flex;gap:12px;flex-wrap:wrap;margin:0 0 8px}
  .btn{text-decoration:none;font-size:14px;font-weight:600;padding:12px 20px;border-radius:8px;background:var(--accent);color:#fff;border:1px solid var(--accent);transition:filter .15s}
  .btn.ghost{background:transparent;color:var(--ink);border-color:var(--line)}
  .btn:hover{filter:brightness(1.1)}
  h2{font-size:12px;text-transform:uppercase;letter-spacing:.09em;color:var(--mut);font-family:ui-monospace,Menlo,monospace;margin:38px 0 14px;font-weight:600}
  .feat{display:grid;grid-template-columns:1fr 1fr;gap:12px}
  .feat div{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px 16px}
  .feat b{display:block;margin-bottom:3px;font-size:14px}
  .feat span{color:var(--mut);font-size:13px}
  table{width:100%;border-collapse:collapse;font-family:ui-monospace,Menlo,monospace;font-size:12.5px;background:var(--card);border:1px solid var(--line);border-radius:10px;overflow:hidden}
  td{padding:10px 12px;border-bottom:1px solid var(--line);vertical-align:top}
  tr:last-child td{border-bottom:0}
  .m{color:var(--accent);white-space:nowrap;font-weight:600}
  .d{color:var(--mut)}
  .stack{font-family:ui-monospace,Menlo,monospace;font-size:13px;color:var(--mut);margin-top:12px}
  footer{margin-top:42px;padding-top:20px;border-top:1px solid var(--line);font-size:13px;color:var(--mut)}
  footer a{color:var(--accent);text-decoration:none}
  @media(max-width:560px){.feat{grid-template-columns:1fr}}
</style></head><body>
<div class="wrap">
  <span class="live"><span class="dot"></span> Live &middot; pay.dsremo.com</span>
  <h1>Payment Orchestrator</h1>
  <p class="sub">A production-shaped payment service: idempotent creation, a server-enforced state machine, HMAC signature verification, full and partial refunds, and signed webhooks. Runs a mock gateway for the public demo, with a real Razorpay (test-mode) adapter wired in.</p>
  <div class="cta">
    <a class="btn" href="/checkout">Try the live checkout demo &rarr;</a>
    <a class="btn ghost" href="https://github.com/dsremo/pay-service" target="_blank" rel="noopener">View the code</a>
  </div>

  <h2>What it does</h2>
  <div class="feat">
    <div><b>Idempotent API</b><span>An Idempotency-Key header dedupes retried payment creation.</span></div>
    <div><b>Enforced state machine</b><span>created &rarr; pending &rarr; success / failed / expired, server-side only.</span></div>
    <div><b>HMAC verification</b><span>Timing-safe SHA-256 signature checks on callbacks and webhooks.</span></div>
    <div><b>Refunds</b><span>Full or partial, guarded against over-refund.</span></div>
    <div><b>Signed webhooks</b><span>Verified gateway events reconcile payment status.</span></div>
    <div><b>Multi-gateway</b><span>Mock gateway for the demo; Razorpay test adapter pluggable.</span></div>
  </div>

  <h2>API</h2>
  <table>
    <tr><td class="m">POST&nbsp;/api/payments</td><td class="d">Create a payment (Idempotency-Key header dedupes).</td></tr>
    <tr><td class="m">GET&nbsp;/api/payments/:id</td><td class="d">Payment status + full event history.</td></tr>
    <tr><td class="m">POST&nbsp;/api/payments/:id/refund</td><td class="d">Full or partial refund.</td></tr>
    <tr><td class="m">GET&nbsp;/api/refunds/:id</td><td class="d">Refund status.</td></tr>
    <tr><td class="m">POST&nbsp;/api/webhook</td><td class="d">Gateway webhook (HMAC-SHA256 verified).</td></tr>
    <tr><td class="m">POST&nbsp;/api/verify-payment</td><td class="d">Verify a Razorpay client callback signature.</td></tr>
  </table>

  <p class="stack">Cloudflare Workers &middot; D1 (SQLite) &middot; Web Crypto &middot; Razorpay</p>

  <footer>
    Built by <a href="https://ashutosh.dsremo.com">Ashutosh Tiwari</a>
    &middot; <a href="https://github.com/dsremo/pay-service" target="_blank" rel="noopener">source</a>
    &middot; <a href="/api">raw API JSON</a>
  </footer>
</div>
</body></html>`;

const CHECKOUT_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Checkout — pay.dsremo.com demo</title>
<script src="https://checkout.razorpay.com/v1/checkout.js"></script>
<style>
  body{margin:0;background:#0d1117;color:#e6edf3;font-family:system-ui,sans-serif;display:grid;place-items:center;min-height:100vh}
  .card{background:#161b22;border:1px solid #30363d;border-radius:14px;padding:28px;width:340px}
  h1{font-size:18px;margin:0 0 4px}
  p.sub{color:#8b949e;font-size:13px;margin:0 0 20px}
  label{display:block;font-size:12px;color:#8b949e;margin:14px 0 6px}
  input{width:100%;padding:11px;border-radius:8px;border:1px solid #30363d;background:#0d1117;color:#e6edf3;font-size:15px;box-sizing:border-box}
  button{width:100%;margin-top:18px;padding:12px;border:0;border-radius:8px;background:#2f81f7;color:#fff;font-size:15px;font-weight:600;cursor:pointer}
  button:disabled{opacity:.6}
  .status{margin-top:16px;font-size:13px;min-height:18px}
  .ok{color:#3fb950}.bad{color:#f85149}.muted{color:#8b949e}
</style></head><body>
<div class="card">
  <h1>Checkout</h1>
  <p class="sub">pay.dsremo.com — live demo</p>
  <label for="amt">Amount (₹)</label>
  <input id="amt" type="number" value="149" min="1">
  <button id="pay">Pay now</button>
  <div class="status muted" id="status"></div>
</div>
<script>
const statusEl=document.getElementById("status");
function setStatus(msg,cls){statusEl.textContent=msg;statusEl.className="status "+(cls||"muted");}
async function poll(id){
  for(let attempt=0;attempt<30;attempt++){
    const res=await fetch("/api/payments/"+id);const data=await res.json();
    if(data.status==="success"){setStatus("Payment successful ✓","ok");return;}
    if(data.status==="failed"){setStatus("Payment failed","bad");return;}
    if(data.status==="expired"){setStatus("Payment expired","bad");return;}
    await new Promise(r=>setTimeout(r,2000));
  }
  setStatus("Still pending — check back shortly.","muted");
}
document.getElementById("pay").onclick=async()=>{
  const rupees=Number(document.getElementById("amt").value);
  if(!rupees||rupees<1){setStatus("Enter a valid amount","bad");return;}
  setStatus("Creating payment…");
  const res=await fetch("/api/payments",{method:"POST",headers:{"content-type":"application/json","Idempotency-Key":crypto.randomUUID()},body:JSON.stringify({amount:Math.round(rupees*100)})});
  const payment=await res.json();
  if(!payment.checkout){setStatus("Mock mode active — approve via POST /api/payments/"+payment.id+"/mock/approve","muted");return;}
  const rzp=new Razorpay({
    key:payment.checkout.razorpay_key_id,
    order_id:payment.checkout.razorpay_order_id,
    name:"dsremo",description:"UPI demo",
    handler:async(response)=>{setStatus("Verifying…");try{const verifyRes=await fetch("/api/verify-payment",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(response)});const verdict=await verifyRes.json();if(verdict.verified&&verdict.status==="success"){setStatus("Payment successful \\u2713","ok");}else if(verdict.verified===false){setStatus("Signature verification failed","bad");}else{poll(payment.id);}}catch(e){poll(payment.id);}},
    modal:{ondismiss:()=>setStatus("Checkout closed.","muted")},
    theme:{color:"#2f81f7"}
  });
  rzp.on("payment.failed",()=>setStatus("Payment failed","bad"));
  rzp.open();
};
</script></body></html>`;

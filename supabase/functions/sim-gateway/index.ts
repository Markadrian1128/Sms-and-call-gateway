const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

type GatewayRequest = {
  mode?: "health";
  action?: "sms" | "call";
  pn?: string;
  phoneNumber?: string;
  message?: string;
  borrower?: string;
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json",
    },
  });
}

function normalizePhoneNumber(value: string) {
  const cleaned = String(value || "")
    .trim()
    .replace(/[^\d+]/g, "")
    .replace(/^00/, "+");

  if (!cleaned) return "";
  if (cleaned.startsWith("+")) return cleaned;
  if (cleaned.startsWith("09") && cleaned.length === 11) {
    return `+63${cleaned.slice(1)}`;
  }
  if (cleaned.startsWith("9") && cleaned.length === 10) {
    return `+63${cleaned}`;
  }
  if (cleaned.startsWith("63") && cleaned.length === 12) {
    return `+${cleaned}`;
  }

  return cleaned;
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (request.method !== "POST") {
    return jsonResponse({ ok: false, error: "Method not allowed." }, 405);
  }

  const gatewayUrl = (Deno.env.get("OWN_SIM_GATEWAY_URL") || "").replace(/\/$/, "");
  const gatewayToken = Deno.env.get("OWN_SIM_GATEWAY_TOKEN") || "";

  if (!gatewayUrl || !gatewayToken) {
    return jsonResponse(
      {
        ok: false,
        error:
          "Own SIM gateway is not configured. Add OWN_SIM_GATEWAY_URL and OWN_SIM_GATEWAY_TOKEN as Supabase secrets.",
      },
      500,
    );
  }

  let body: GatewayRequest;

  try {
    body = await request.json();
  } catch {
    return jsonResponse({ ok: false, error: "Invalid JSON body." }, 400);
  }

  if (body.mode === "health") {
    try {
      const health = await fetch(`${gatewayUrl}/health`);
      const text = await health.text();
      let details: unknown = text;
      try {
        details = text ? JSON.parse(text) : null;
      } catch {
        details = text;
      }
      return jsonResponse({ ok: health.ok, gateway: details }, health.ok ? 200 : 502);
    } catch (error) {
      return jsonResponse(
        {
          ok: false,
          error:
            error instanceof Error
              ? error.message
              : "Unable to reach own SIM gateway.",
        },
        502,
      );
    }
  }

  const action = body.action || "sms";
  if (!["sms", "call"].includes(action)) {
    return jsonResponse({ ok: false, error: "Action must be sms or call." }, 400);
  }

  const phoneNumber = normalizePhoneNumber(body.phoneNumber || "");
  if (!phoneNumber) {
    return jsonResponse({ ok: false, error: "Recipient number is required." }, 400);
  }

  const payload: Record<string, unknown> = {
    pn: body.pn || null,
    borrower: body.borrower || "",
    phoneNumber,
  };

  if (action === "sms") {
    const message = String(body.message || "").trim();
    if (!message) {
      return jsonResponse({ ok: false, error: "Message is required." }, 400);
    }
    payload.message = message;
  }

  try {
    const response = await fetch(`${gatewayUrl}/${action}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${gatewayToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    const responseText = await response.text();
    let responseBody: unknown = responseText;

    try {
      responseBody = responseText ? JSON.parse(responseText) : null;
    } catch {
      responseBody = responseText;
    }

    if (!response.ok) {
      return jsonResponse(
        {
          ok: false,
          error: "Own SIM gateway rejected the request.",
          status: response.status,
          details: responseBody,
        },
        response.status,
      );
    }

    return jsonResponse({
      ok: true,
      action,
      pn: body.pn || null,
      phoneNumber,
      gateway: responseBody,
    });
  } catch (error) {
    return jsonResponse(
      {
        ok: false,
        error:
          error instanceof Error
            ? error.message
            : "Unable to reach own SIM gateway.",
      },
      502,
    );
  }
});

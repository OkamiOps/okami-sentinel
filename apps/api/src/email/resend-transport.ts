import type { EmailErrorCode } from "@csb/shared";
import {
  EMAIL_TIMEOUT_MS,
  emailFailure,
  EmailTransportError,
  emailTransportError,
  formatSender,
  type EmailFailure,
  type EmailMessage,
  type EmailSendResult,
  type EmailTransport,
  type EmailTransportConfig,
} from "./transport.js";

export const RESEND_ENDPOINT = "https://api.resend.com/emails";

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

/**
 * Resend's HTTP API. The outbox row id travels as `Idempotency-Key`, which is
 * what makes a retry after an ambiguous failure — a timeout after the request
 * left, a restart mid-send — safe: Resend replays the original result instead of
 * delivering a second copy.
 */
export function createResendTransport(
  config: EmailTransportConfig,
  fetchImpl: FetchLike = globalThis.fetch as FetchLike,
): EmailTransport {
  const apiKey = config.secret?.trim() ?? "";
  return {
    async send(message: EmailMessage): Promise<EmailSendResult> {
      if (!apiKey) throw emailTransportError("not_configured");
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), config.timeoutMs ?? EMAIL_TIMEOUT_MS);
      let response: Response;
      try {
        response = await fetchImpl(RESEND_ENDPOINT, {
          method: "POST",
          signal: controller.signal,
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
            "Idempotency-Key": message.idempotencyKey,
          },
          body: JSON.stringify({
            from: formatSender(config.fromName, config.fromAddress),
            to: [message.to],
            subject: message.subject,
            html: message.html,
            text: message.text,
            ...(config.replyTo ? { reply_to: config.replyTo } : {}),
          }),
        });
      } catch (error) {
        throw new EmailTransportError(mapResendNetworkError(error, controller.signal.aborted));
      } finally {
        clearTimeout(timer);
      }

      const body = await readJson(response);
      if (!response.ok) throw new EmailTransportError(mapResendResponse(response.status, body));
      const id = (body as { id?: unknown } | null)?.id;
      return { providerMessageId: typeof id === "string" && id ? id : null };
    },
  };
}

async function readJson(response: Response): Promise<unknown> {
  try {
    const text = await response.text();
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

export function mapResendNetworkError(error: unknown, aborted: boolean): EmailFailure {
  if (aborted) return emailFailure("connection_timeout");
  const cause = (error as { cause?: { code?: string } } | undefined)?.cause?.code ?? "";
  const message = error instanceof Error ? error.message : String(error);
  if (cause === "ECONNREFUSED" || /ECONNREFUSED/.test(message)) return emailFailure("connection_refused", message);
  if (/ENOTFOUND|EAI_AGAIN/.test(`${cause} ${message}`)) return emailFailure("connection_refused", message);
  if (/ERR_TLS|certificate|SSL/i.test(`${cause} ${message}`)) return emailFailure("tls_failed", message);
  return emailFailure("provider_unavailable", message);
}

/**
 * Resend answers `422` both for a domain that was never verified and for a
 * malformed recipient, and only the message text separates them; the wording is
 * matched loosely on purpose, and anything unrecognised degrades to
 * `message_rejected` rather than claiming a cause.
 */
export function mapResendResponse(status: number, body: unknown): EmailFailure {
  const detail = resendDetail(body);
  if (status === 401 || status === 403) return emailFailure("auth_rejected", detail);
  if (status === 429) return emailFailure("rate_limited", detail);
  if (status >= 500) return emailFailure("provider_unavailable", detail);
  if (status === 408) return emailFailure("connection_timeout", detail);
  return emailFailure(clientErrorCode(detail), detail);
}

function clientErrorCode(detail: string | null): EmailErrorCode {
  const text = detail ?? "";
  if (/not verified|verify a domain|domain is not|sender|from.*address/i.test(text)) return "sender_not_verified";
  if (/recipient|`to`|invalid.*email|to.*invalid/i.test(text)) return "recipient_rejected";
  return "message_rejected";
}

function resendDetail(body: unknown): string | null {
  if (typeof body === "string") return body;
  if (body === null || typeof body !== "object") return null;
  const record = body as { message?: unknown; error?: unknown; name?: unknown };
  for (const candidate of [record.message, record.error, record.name]) {
    if (typeof candidate === "string" && candidate.trim()) return candidate;
  }
  return null;
}

import { getIntlLocale, translate, type TranslationKey } from "../i18n";

export type ApiErrorKind = "http" | "invalid" | "empty";

export class ApiError extends Error {
  readonly kind: ApiErrorKind;
  readonly status: number | null;
  readonly hasGenericHttpMessage: boolean;

  constructor(message: string, kind: ApiErrorKind, status: number | null = null) {
    const genericHttp = kind === "http" && message.startsWith("api_http_");
    super(kind === "invalid" ? translate(getIntlLocale(), "common.apiInvalidResponse")
      : kind === "empty" ? translate(getIntlLocale(), "common.apiEmptyResponse")
        : genericHttp ? translate(getIntlLocale(), "common.apiUnavailable", { status: status ?? "—" }) : message);
    this.name = "ApiError";
    this.kind = kind;
    this.status = status;
    this.hasGenericHttpMessage = genericHttp;
  }
}

export type Translator = (key: TranslationKey, variables?: Record<string, string | number>) => string;

export function formatApiError(error: unknown, t: Translator): string {
  if (error instanceof ApiError) {
    if (error.kind === "invalid") return t("common.apiInvalidResponse");
    if (error.kind === "empty") return t("common.apiEmptyResponse");
    if (error.hasGenericHttpMessage) return t("common.apiUnavailable", { status: error.status ?? "—" });
    return error.message;
  }
  if (error instanceof TypeError && /failed to fetch|fetch failed|networkerror|network request failed|load failed/i.test(error.message)) {
    return t("common.requestFailed");
  }
  return error instanceof Error ? error.message : t("common.requestFailed");
}

export async function parseApiResponse<T>(response: Response): Promise<T> {
  const text = await response.text();
  let body: (T & { error?: string }) | null = null;
  if (text) {
    try {
      body = JSON.parse(text) as T & { error?: string };
    } catch {
      if (response.ok) throw new ApiError("invalid_api_response", "invalid", response.status);
    }
  }
  if (!response.ok) {
    // Keep provider-specific error codes available to the CSRF retry path while
    // allowing the UI to translate the visible message by status.
    throw new ApiError(body?.error ?? `api_http_${response.status}`, "http", response.status);
  }
  if (!body) throw new ApiError("empty_api_response", "empty", response.status);
  return body;
}

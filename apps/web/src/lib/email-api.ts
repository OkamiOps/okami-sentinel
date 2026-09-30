import type {
  AccountNotificationsResponse,
  AccountNotificationsUpdateEntry,
  EmailDelivery,
  EmailSettingsResponse,
  EmailTestResult,
} from "@csb/shared";
import { authedRequest } from "./api-request.js";

/**
 * What `PUT /email/settings` accepts. Every field is optional because the route
 * merges the body over the stored row, and `secret` is the one field with three
 * meanings: absent keeps the stored value, a string replaces it, `null` clears
 * it. The form therefore never sends an empty string by accident.
 */
export interface EmailSettingsInput {
  provider?: string;
  enabled?: boolean;
  fromName?: string;
  fromAddress?: string | null;
  replyTo?: string | null;
  smtpHost?: string | null;
  /**
   * A string reaches the API only when the administrator typed something that
   * is not a port: the route then names the field, instead of this screen
   * inventing a rule or `JSON.stringify` dropping a `NaN` silently.
   */
  smtpPort?: number | string | null;
  smtpSecurity?: string;
  smtpUsername?: string | null;
  secret?: string | null;
}

export const emailApi = {
  settings(): Promise<EmailSettingsResponse> {
    return authedRequest<EmailSettingsResponse>("/email/settings");
  },

  saveSettings(input: EmailSettingsInput): Promise<EmailSettingsResponse> {
    return authedRequest<EmailSettingsResponse>("/email/settings", {
      method: "PUT",
      body: JSON.stringify(input),
    });
  },

  /**
   * A provider rejection answers 200 with `ok: false`: the provider's own
   * error is the payload this screen renders, not an HTTP failure of ours.
   */
  sendTest(): Promise<EmailTestResult> {
    return authedRequest<EmailTestResult>("/email/test", { method: "POST" });
  },

  async deliveries(): Promise<EmailDelivery[]> {
    return (await authedRequest<{ deliveries: EmailDelivery[] }>("/email/deliveries")).deliveries;
  },
};

export const notificationsApi = {
  get(): Promise<AccountNotificationsResponse> {
    return authedRequest<AccountNotificationsResponse>("/account/notifications");
  },

  /** A sparse patch: only the cells that changed, and the full matrix back. */
  update(subscriptions: AccountNotificationsUpdateEntry[]): Promise<AccountNotificationsResponse> {
    return authedRequest<AccountNotificationsResponse>("/account/notifications", {
      method: "PUT",
      body: JSON.stringify({ subscriptions }),
    });
  },
};

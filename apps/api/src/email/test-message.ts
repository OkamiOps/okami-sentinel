import type { UserLocale } from "@csb/shared";

/**
 * The one message Task 1 renders itself. It exists so the Settings screen can
 * prove a provider works before any notification depends on it, so it carries
 * nothing but the brand, the destination and the time — no repository, no
 * finding, no token. The full template set arrives with the outbox worker.
 */
export interface TestEmailInput {
  locale: UserLocale;
  to: string;
  /** `null` in local mode: the message then names no link at all. */
  origin: string | null;
  now: Date;
}

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

interface Copy {
  subject: string;
  heading: string;
  body: string;
  sentTo: (address: string) => string;
  at: (moment: string) => string;
  link: string;
  footer: string;
}

const COPY: Readonly<Record<UserLocale, Copy>> = Object.freeze({
  "pt-BR": {
    subject: "Okami Sentinel: e-mail de teste",
    heading: "O e-mail está funcionando",
    body: "Este é um envio de teste feito nas configurações do Okami Sentinel. Se você recebeu esta mensagem, o provedor está configurado corretamente.",
    sentTo: (address) => `Enviado para ${address}.`,
    at: (moment) => `Horário do envio: ${moment}.`,
    link: "Abrir o Okami Sentinel",
    footer: "Você recebeu esta mensagem porque um administrador pediu um envio de teste.",
  },
  en: {
    subject: "Okami Sentinel: test e-mail",
    heading: "E-mail is working",
    body: "This is a test send from the Okami Sentinel settings. If this message reached you, the provider is configured correctly.",
    sentTo: (address) => `Sent to ${address}.`,
    at: (moment) => `Sent at ${moment}.`,
    link: "Open Okami Sentinel",
    footer: "You received this message because an administrator asked for a test send.",
  },
  es: {
    subject: "Okami Sentinel: correo de prueba",
    heading: "El correo funciona",
    body: "Este es un envío de prueba desde la configuración de Okami Sentinel. Si recibiste este mensaje, el proveedor está configurado correctamente.",
    sentTo: (address) => `Enviado a ${address}.`,
    at: (moment) => `Hora del envío: ${moment}.`,
    link: "Abrir Okami Sentinel",
    footer: "Recibiste este mensaje porque un administrador solicitó un envío de prueba.",
  },
  de: {
    subject: "Okami Sentinel: Test-E-Mail",
    heading: "Der E-Mail-Versand funktioniert",
    body: "Dies ist ein Testversand aus den Einstellungen von Okami Sentinel. Wenn diese Nachricht angekommen ist, ist der Anbieter korrekt konfiguriert.",
    sentTo: (address) => `Gesendet an ${address}.`,
    at: (moment) => `Gesendet am ${moment}.`,
    link: "Okami Sentinel öffnen",
    footer: "Sie haben diese Nachricht erhalten, weil eine Administratorin oder ein Administrator einen Testversand angefordert hat.",
  },
  fr: {
    subject: "Okami Sentinel : e-mail de test",
    heading: "L'envoi d'e-mails fonctionne",
    body: "Ceci est un envoi de test effectué depuis les paramètres d'Okami Sentinel. Si vous avez reçu ce message, le fournisseur est correctement configuré.",
    sentTo: (address) => `Envoyé à ${address}.`,
    at: (moment) => `Envoyé le ${moment}.`,
    link: "Ouvrir Okami Sentinel",
    footer: "Vous recevez ce message parce qu'un administrateur a demandé un envoi de test.",
  },
});

const HTML_ENTITIES: Readonly<Record<string, string>> = Object.freeze({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
});

/**
 * One pass over the five characters that can change the meaning of an HTML text
 * node or a quoted attribute. Nothing here builds markup from caller-supplied
 * HTML — every interpolation is a plain string — so escaping is the whole job and
 * a sanitizer, which exists to *keep* some markup, would be the wrong tool.
 */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => HTML_ENTITIES[character] ?? character);
}

export function renderTestEmail(input: TestEmailInput): RenderedEmail {
  const copy = COPY[input.locale];
  const moment = input.now.toISOString().replace("T", " ").slice(0, 19) + " UTC";
  const lines = [copy.heading, "", copy.body, "", copy.sentTo(input.to), copy.at(moment)];
  // No public origin means no absolute link, and a relative one would be dead in
  // a mail client, so the message simply has no link.
  if (input.origin !== null) lines.push("", `${copy.link}: ${input.origin}/settings/email`);
  lines.push("", copy.footer);

  const linkHtml = input.origin === null
    ? ""
    : `<p style="margin:24px 0 0"><a href="${escapeHtml(input.origin)}/settings/email" style="color:#b45309;font-weight:600;text-decoration:none">${escapeHtml(copy.link)}</a></p>`;

  return {
    subject: copy.subject,
    text: lines.join("\n"),
    html: [
      `<!doctype html><html lang="${escapeHtml(input.locale)}"><body style="margin:0;padding:24px;background:#f5f5f4;font-family:ui-sans-serif,system-ui,'Segoe UI',Roboto,sans-serif;color:#1c1917">`,
      `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #e7e5e4;border-radius:12px"><tr><td style="padding:28px">`,
      `<p style="margin:0 0 16px;font-size:12px;letter-spacing:.12em;text-transform:uppercase;color:#a8a29e">Okami Sentinel</p>`,
      `<h1 style="margin:0 0 12px;font-size:20px;line-height:1.3">${escapeHtml(copy.heading)}</h1>`,
      `<p style="margin:0 0 16px;font-size:14px;line-height:1.6">${escapeHtml(copy.body)}</p>`,
      `<p style="margin:0;font-size:13px;line-height:1.6;color:#57534e">${escapeHtml(copy.sentTo(input.to))}<br>${escapeHtml(copy.at(moment))}</p>`,
      linkHtml,
      `</td></tr><tr><td style="padding:0 28px 24px;font-size:12px;line-height:1.5;color:#a8a29e">${escapeHtml(copy.footer)}</td></tr></table>`,
      `</body></html>`,
    ].join(""),
  };
}

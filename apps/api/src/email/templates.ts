import { type UserLocale } from "@csb/shared";

/**
 * Every e-mail the Sentinel sends is rendered here, by one shell, in the five
 * interface languages. One module rather than one file per message, because the
 * shell — brand, layout, footer, escaping, link handling — is the part that must
 * not diverge: a second HTML skeleton somewhere else is how a message ends up
 * without a footer, or with an unescaped display name in it.
 *
 * Adding a message (Task 3's repository and ops events) means three edits and no
 * new file: an entry in `EmailMessageDataMap`, a `defineTemplate` call, and the
 * registry line that binds the two. The shell, the locales, the escaping and the
 * footer come with it.
 *
 * Nothing in here formats a date with `Intl`: a notification is read next to a
 * log line, so every timestamp is the same unambiguous UTC stamp in all five
 * languages, and the rendered body stays byte-identical across runtimes with
 * different ICU data.
 */

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

/**
 * The data each message kind needs. The key is also the `event` column in
 * `email_outbox`, so the outbox row and the template that produced it can never
 * disagree about what the message was.
 */
export interface EmailMessageDataMap {
  /** The one message an administrator sends on purpose, from the settings screen. */
  "account.test": { to: string; at: Date };
  "account.invite": { inviterName: string | null; inviteToken: string; expiresAt: Date };
  "account.reset": { resetToken: string; expiresAt: Date };
  "account.new_login": { at: Date; ip: string | null; browser: string | null };
  "account.locked": { at: Date; retryAfterSeconds: number };
  "account.password_changed": { at: Date };
}

export type EmailMessageKind = keyof EmailMessageDataMap;

/**
 * Which footer a message gets. Account messages cannot be turned off, so their
 * footer points at Minha conta; everything else points at the subscription
 * matrix the recipient can actually act on.
 */
export type EmailMessageGroup = "account" | "repository" | "ops";

/** What a template produces; the shell turns this into HTML and text. */
export interface EmailTemplateBody {
  subject: string;
  heading: string;
  paragraphs: string[];
  /** Label/value pairs: the time, the address, the counts. Never evidence. */
  facts: Array<{ label: string; value: string }>;
  /** A path, never a URL: the shell owns the origin and the local-mode rule. */
  action: { label: string; path: string } | null;
  /** Why this message reached this person, in their language. */
  reason: string;
}

interface TemplateDefinition<K extends EmailMessageKind> {
  group: EmailMessageGroup;
  build(data: EmailMessageDataMap[K], locale: UserLocale): EmailTemplateBody;
}

/**
 * Binds one kind's per-locale copy to one builder. The copy type is inferred
 * from the table, so a locale missing a string the builder uses is a type error
 * rather than an `undefined` in someone's inbox.
 */
function defineTemplate<K extends EmailMessageKind, C>(definition: {
  group: EmailMessageGroup;
  copy: Readonly<Record<UserLocale, C>>;
  build(data: EmailMessageDataMap[K], copy: C): EmailTemplateBody;
}): TemplateDefinition<K> {
  return {
    group: definition.group,
    build: (data, locale) => definition.build(data, definition.copy[locale]),
  };
}

/** `2026-09-30 14:05:09 UTC` — the same in every language, on purpose. */
export function formatMoment(value: Date): string {
  return `${value.toISOString().replace("T", " ").slice(0, 19)} UTC`;
}

function minutesUntil(seconds: number): number {
  return Math.max(1, Math.ceil(seconds / 60));
}

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

// --------------------------------------------------------------------------
// The shell's own copy: brand line, footer and the local-mode notice.
// --------------------------------------------------------------------------

interface ShellCopy {
  brand: string;
  why: string;
  accountLink: string;
  notificationsLink: string;
  /** Said instead of a link when the installation has no public address. */
  noLinks: string;
}

const SHELL: Readonly<Record<UserLocale, ShellCopy>> = Object.freeze({
  "pt-BR": {
    brand: "Okami Sentinel",
    why: "Por que você recebeu isto",
    accountLink: "Minha conta",
    notificationsLink: "Minha conta → Notificações",
    noLinks: "Esta instalação não tem endereço público configurado, por isso esta mensagem não traz links.",
  },
  en: {
    brand: "Okami Sentinel",
    why: "Why you received this",
    accountLink: "My account",
    notificationsLink: "My account → Notifications",
    noLinks: "This installation has no public address configured, so this message carries no links.",
  },
  es: {
    brand: "Okami Sentinel",
    why: "Por qué recibiste esto",
    accountLink: "Mi cuenta",
    notificationsLink: "Mi cuenta → Notificaciones",
    noLinks: "Esta instalación no tiene una dirección pública configurada, por eso este mensaje no incluye enlaces.",
  },
  de: {
    brand: "Okami Sentinel",
    why: "Warum Sie diese Nachricht erhalten",
    accountLink: "Mein Konto",
    notificationsLink: "Mein Konto → Benachrichtigungen",
    noLinks: "Für diese Installation ist keine öffentliche Adresse konfiguriert, daher enthält diese Nachricht keine Links.",
  },
  fr: {
    brand: "Okami Sentinel",
    why: "Pourquoi vous recevez ce message",
    accountLink: "Mon compte",
    notificationsLink: "Mon compte → Notifications",
    noLinks: "Cette installation n'a pas d'adresse publique configurée, ce message ne contient donc aucun lien.",
  },
});

/** Minha conta, and the anchor the notification matrix lives under. */
const ACCOUNT_PATH = "/settings/account";
const NOTIFICATIONS_PATH = "/settings/account#notifications";

// --------------------------------------------------------------------------
// account.test
// --------------------------------------------------------------------------

const accountTest = defineTemplate<"account.test", {
  subject: string; heading: string; body: string; sentTo: string; at: string;
  action: string; reason: string;
}>({
  group: "account",
  copy: {
    "pt-BR": {
      subject: "Okami Sentinel: e-mail de teste",
      heading: "O e-mail está funcionando",
      body: "Este é um envio de teste feito nas configurações do Okami Sentinel. Se você recebeu esta mensagem, o provedor está configurado corretamente.",
      sentTo: "Enviado para", at: "Horário do envio",
      action: "Abrir as configurações de e-mail",
      reason: "Você recebeu esta mensagem porque um administrador pediu um envio de teste.",
    },
    en: {
      subject: "Okami Sentinel: test e-mail",
      heading: "E-mail is working",
      body: "This is a test send from the Okami Sentinel settings. If this message reached you, the provider is configured correctly.",
      sentTo: "Sent to", at: "Sent at",
      action: "Open the e-mail settings",
      reason: "You received this message because an administrator asked for a test send.",
    },
    es: {
      subject: "Okami Sentinel: correo de prueba",
      heading: "El correo funciona",
      body: "Este es un envío de prueba desde la configuración de Okami Sentinel. Si recibiste este mensaje, el proveedor está configurado correctamente.",
      sentTo: "Enviado a", at: "Hora del envío",
      action: "Abrir la configuración de correo",
      reason: "Recibiste este mensaje porque un administrador solicitó un envío de prueba.",
    },
    de: {
      subject: "Okami Sentinel: Test-E-Mail",
      heading: "Der E-Mail-Versand funktioniert",
      body: "Dies ist ein Testversand aus den Einstellungen von Okami Sentinel. Wenn diese Nachricht angekommen ist, ist der Anbieter korrekt konfiguriert.",
      sentTo: "Gesendet an", at: "Gesendet am",
      action: "E-Mail-Einstellungen öffnen",
      reason: "Sie haben diese Nachricht erhalten, weil eine Administratorin oder ein Administrator einen Testversand angefordert hat.",
    },
    fr: {
      subject: "Okami Sentinel : e-mail de test",
      heading: "L'envoi d'e-mails fonctionne",
      body: "Ceci est un envoi de test effectué depuis les paramètres d'Okami Sentinel. Si vous avez reçu ce message, le fournisseur est correctement configuré.",
      sentTo: "Envoyé à", at: "Envoyé le",
      action: "Ouvrir les paramètres d'e-mail",
      reason: "Vous recevez ce message parce qu'un administrateur a demandé un envoi de test.",
    },
  },
  build: (data, copy) => ({
    subject: copy.subject,
    heading: copy.heading,
    paragraphs: [copy.body],
    facts: [
      { label: copy.sentTo, value: data.to },
      { label: copy.at, value: formatMoment(data.at) },
    ],
    action: { label: copy.action, path: "/settings/email" },
    reason: copy.reason,
  }),
});

// --------------------------------------------------------------------------
// account.invite
// --------------------------------------------------------------------------

const accountInvite = defineTemplate<"account.invite", {
  subject: string; heading: string; byName: (name: string) => string; byAdmin: string;
  next: string; expires: string; action: string; reason: string;
}>({
  group: "account",
  copy: {
    "pt-BR": {
      subject: "Okami Sentinel: seu convite de acesso",
      heading: "Você foi convidado ao Okami Sentinel",
      byName: (name) => `${name} criou uma conta para você no Okami Sentinel.`,
      byAdmin: "Um administrador criou uma conta para você no Okami Sentinel.",
      next: "Para entrar, defina uma senha usando o link do convite. Ele vale uma única vez.",
      expires: "O convite expira em", action: "Definir minha senha",
      reason: "Você recebeu esta mensagem porque uma conta foi criada para você no Okami Sentinel.",
    },
    en: {
      subject: "Okami Sentinel: your access invitation",
      heading: "You have been invited to Okami Sentinel",
      byName: (name) => `${name} created an account for you on Okami Sentinel.`,
      byAdmin: "An administrator created an account for you on Okami Sentinel.",
      next: "To sign in, set a password using the invitation link. It works once.",
      expires: "The invitation expires at", action: "Set my password",
      reason: "You received this message because an account was created for you on Okami Sentinel.",
    },
    es: {
      subject: "Okami Sentinel: tu invitación de acceso",
      heading: "Te invitaron a Okami Sentinel",
      byName: (name) => `${name} creó una cuenta para ti en Okami Sentinel.`,
      byAdmin: "Un administrador creó una cuenta para ti en Okami Sentinel.",
      next: "Para entrar, define una contraseña con el enlace de la invitación. Sirve una sola vez.",
      expires: "La invitación expira el", action: "Definir mi contraseña",
      reason: "Recibiste este mensaje porque se creó una cuenta para ti en Okami Sentinel.",
    },
    de: {
      subject: "Okami Sentinel: Ihre Zugangseinladung",
      heading: "Sie wurden zu Okami Sentinel eingeladen",
      byName: (name) => `${name} hat ein Konto für Sie in Okami Sentinel angelegt.`,
      byAdmin: "Eine Administratorin oder ein Administrator hat ein Konto für Sie in Okami Sentinel angelegt.",
      next: "Legen Sie zum Anmelden über den Einladungslink ein Passwort fest. Der Link gilt einmalig.",
      expires: "Die Einladung läuft ab am", action: "Passwort festlegen",
      reason: "Sie haben diese Nachricht erhalten, weil in Okami Sentinel ein Konto für Sie angelegt wurde.",
    },
    fr: {
      subject: "Okami Sentinel : votre invitation d'accès",
      heading: "Vous avez été invité à Okami Sentinel",
      byName: (name) => `${name} a créé un compte pour vous dans Okami Sentinel.`,
      byAdmin: "Un administrateur a créé un compte pour vous dans Okami Sentinel.",
      next: "Pour vous connecter, définissez un mot de passe avec le lien d'invitation. Il ne fonctionne qu'une fois.",
      expires: "L'invitation expire le", action: "Définir mon mot de passe",
      reason: "Vous recevez ce message parce qu'un compte a été créé pour vous dans Okami Sentinel.",
    },
  },
  build: (data, copy) => ({
    subject: copy.subject,
    heading: copy.heading,
    paragraphs: [data.inviterName ? copy.byName(data.inviterName) : copy.byAdmin, copy.next],
    facts: [{ label: copy.expires, value: formatMoment(data.expiresAt) }],
    action: { label: copy.action, path: `/invite/${data.inviteToken}` },
    reason: copy.reason,
  }),
});

// --------------------------------------------------------------------------
// account.reset
// --------------------------------------------------------------------------

const accountReset = defineTemplate<"account.reset", {
  subject: string; heading: string; body: string; sessions: string;
  expires: string; action: string; reason: string;
}>({
  group: "account",
  copy: {
    "pt-BR": {
      subject: "Okami Sentinel: redefinição de senha",
      heading: "Defina uma nova senha",
      body: "Um administrador criou um link para você escolher uma nova senha no Okami Sentinel.",
      sessions: "Suas sessões abertas foram encerradas. Se não foi você que pediu isto, procure um administrador.",
      expires: "O link expira em", action: "Definir uma nova senha",
      reason: "Você recebeu esta mensagem porque um administrador pediu a redefinição da sua senha.",
    },
    en: {
      subject: "Okami Sentinel: password reset",
      heading: "Set a new password",
      body: "An administrator created a link for you to choose a new password on Okami Sentinel.",
      sessions: "Your open sessions were signed out. If you did not ask for this, talk to an administrator.",
      expires: "The link expires at", action: "Set a new password",
      reason: "You received this message because an administrator asked for your password to be reset.",
    },
    es: {
      subject: "Okami Sentinel: restablecer la contraseña",
      heading: "Define una nueva contraseña",
      body: "Un administrador creó un enlace para que elijas una nueva contraseña en Okami Sentinel.",
      sessions: "Tus sesiones abiertas se cerraron. Si no pediste esto, habla con un administrador.",
      expires: "El enlace expira el", action: "Definir una nueva contraseña",
      reason: "Recibiste este mensaje porque un administrador solicitó restablecer tu contraseña.",
    },
    de: {
      subject: "Okami Sentinel: Passwort zurücksetzen",
      heading: "Neues Passwort festlegen",
      body: "Eine Administratorin oder ein Administrator hat einen Link erstellt, mit dem Sie in Okami Sentinel ein neues Passwort wählen.",
      sessions: "Ihre offenen Sitzungen wurden beendet. Wenn Sie das nicht angefordert haben, wenden Sie sich an eine Administratorin oder einen Administrator.",
      expires: "Der Link läuft ab am", action: "Neues Passwort festlegen",
      reason: "Sie haben diese Nachricht erhalten, weil das Zurücksetzen Ihres Passworts angefordert wurde.",
    },
    fr: {
      subject: "Okami Sentinel : réinitialisation du mot de passe",
      heading: "Définissez un nouveau mot de passe",
      body: "Un administrateur a créé un lien pour que vous choisissiez un nouveau mot de passe dans Okami Sentinel.",
      sessions: "Vos sessions ouvertes ont été fermées. Si vous n'avez rien demandé, contactez un administrateur.",
      expires: "Le lien expire le", action: "Définir un nouveau mot de passe",
      reason: "Vous recevez ce message parce qu'un administrateur a demandé la réinitialisation de votre mot de passe.",
    },
  },
  build: (data, copy) => ({
    subject: copy.subject,
    heading: copy.heading,
    paragraphs: [copy.body, copy.sessions],
    facts: [{ label: copy.expires, value: formatMoment(data.expiresAt) }],
    action: { label: copy.action, path: `/invite/${data.resetToken}` },
    reason: copy.reason,
  }),
});

// --------------------------------------------------------------------------
// account.new_login
// --------------------------------------------------------------------------

const accountNewLogin = defineTemplate<"account.new_login", {
  subject: string; heading: string; body: string; advice: string;
  at: string; ip: string; browser: string; unknown: string;
  action: string; reason: string;
}>({
  group: "account",
  copy: {
    "pt-BR": {
      subject: "Okami Sentinel: novo acesso à sua conta",
      heading: "Novo acesso à sua conta",
      body: "Sua conta foi acessada de um endereço e navegador que ainda não apareciam nas suas sessões recentes.",
      advice: "Se foi você, não há nada a fazer. Se não foi, troque sua senha e encerre as outras sessões em Minha conta.",
      at: "Horário", ip: "Endereço IP", browser: "Navegador", unknown: "não registrado",
      action: "Abrir Minha conta",
      reason: "Você recebeu esta mensagem porque ela é um alerta de segurança da conta; estes alertas não podem ser desligados.",
    },
    en: {
      subject: "Okami Sentinel: new sign-in to your account",
      heading: "New sign-in to your account",
      body: "Your account was accessed from an address and browser that had not appeared in your recent sessions.",
      advice: "If this was you, there is nothing to do. If it was not, change your password and sign out the other sessions in My account.",
      at: "Time", ip: "IP address", browser: "Browser", unknown: "not recorded",
      action: "Open My account",
      reason: "You received this message because it is an account security alert; these alerts cannot be turned off.",
    },
    es: {
      subject: "Okami Sentinel: nuevo acceso a tu cuenta",
      heading: "Nuevo acceso a tu cuenta",
      body: "Se accedió a tu cuenta desde una dirección y un navegador que no aparecían en tus sesiones recientes.",
      advice: "Si fuiste tú, no hay nada que hacer. Si no, cambia tu contraseña y cierra las otras sesiones en Mi cuenta.",
      at: "Hora", ip: "Dirección IP", browser: "Navegador", unknown: "no registrado",
      action: "Abrir Mi cuenta",
      reason: "Recibiste este mensaje porque es una alerta de seguridad de la cuenta; estas alertas no se pueden desactivar.",
    },
    de: {
      subject: "Okami Sentinel: neue Anmeldung an Ihrem Konto",
      heading: "Neue Anmeldung an Ihrem Konto",
      body: "Auf Ihr Konto wurde von einer Adresse und einem Browser zugegriffen, die in Ihren letzten Sitzungen nicht vorkamen.",
      advice: "Waren Sie das, ist nichts zu tun. Andernfalls ändern Sie Ihr Passwort und beenden Sie die übrigen Sitzungen unter Mein Konto.",
      at: "Zeitpunkt", ip: "IP-Adresse", browser: "Browser", unknown: "nicht erfasst",
      action: "Mein Konto öffnen",
      reason: "Sie haben diese Nachricht erhalten, weil sie eine Sicherheitswarnung zu Ihrem Konto ist; solche Warnungen lassen sich nicht abschalten.",
    },
    fr: {
      subject: "Okami Sentinel : nouvelle connexion à votre compte",
      heading: "Nouvelle connexion à votre compte",
      body: "Votre compte a été utilisé depuis une adresse et un navigateur absents de vos sessions récentes.",
      advice: "Si c'était vous, il n'y a rien à faire. Sinon, changez votre mot de passe et fermez les autres sessions dans Mon compte.",
      at: "Heure", ip: "Adresse IP", browser: "Navigateur", unknown: "non enregistré",
      action: "Ouvrir Mon compte",
      reason: "Vous recevez ce message parce qu'il s'agit d'une alerte de sécurité du compte ; ces alertes ne peuvent pas être désactivées.",
    },
  },
  build: (data, copy) => ({
    subject: copy.subject,
    heading: copy.heading,
    paragraphs: [copy.body, copy.advice],
    facts: [
      { label: copy.at, value: formatMoment(data.at) },
      { label: copy.ip, value: data.ip ?? copy.unknown },
      { label: copy.browser, value: data.browser ?? copy.unknown },
    ],
    action: { label: copy.action, path: ACCOUNT_PATH },
    reason: copy.reason,
  }),
});

// --------------------------------------------------------------------------
// account.locked
// --------------------------------------------------------------------------

const accountLocked = defineTemplate<"account.locked", {
  subject: string; heading: string; body: string; advice: string;
  at: string; retry: string; wait: (minutes: number) => string;
  action: string; reason: string;
}>({
  group: "account",
  copy: {
    "pt-BR": {
      subject: "Okami Sentinel: sua conta foi bloqueada temporariamente",
      heading: "Conta bloqueada temporariamente",
      body: "Houve tentativas de login suficientes com a senha errada para bloquear sua conta por um período.",
      advice: "Se não foi você tentando entrar, troque sua senha assim que o bloqueio terminar e avise um administrador.",
      at: "Horário do bloqueio", retry: "Nova tentativa em",
      wait: (minutes) => (minutes === 1 ? "1 minuto" : `${minutes} minutos`),
      action: "Abrir Minha conta",
      reason: "Você recebeu esta mensagem porque ela é um alerta de segurança da conta; estes alertas não podem ser desligados.",
    },
    en: {
      subject: "Okami Sentinel: your account was locked temporarily",
      heading: "Account locked temporarily",
      body: "There were enough sign-in attempts with the wrong password to lock your account for a while.",
      advice: "If it was not you trying to sign in, change your password as soon as the lock ends and tell an administrator.",
      at: "Locked at", retry: "Try again in",
      wait: (minutes) => (minutes === 1 ? "1 minute" : `${minutes} minutes`),
      action: "Open My account",
      reason: "You received this message because it is an account security alert; these alerts cannot be turned off.",
    },
    es: {
      subject: "Okami Sentinel: tu cuenta se bloqueó temporalmente",
      heading: "Cuenta bloqueada temporalmente",
      body: "Hubo suficientes intentos de inicio de sesión con la contraseña incorrecta para bloquear tu cuenta por un tiempo.",
      advice: "Si no fuiste tú, cambia tu contraseña en cuanto termine el bloqueo y avisa a un administrador.",
      at: "Hora del bloqueo", retry: "Reintentar en",
      wait: (minutes) => (minutes === 1 ? "1 minuto" : `${minutes} minutos`),
      action: "Abrir Mi cuenta",
      reason: "Recibiste este mensaje porque es una alerta de seguridad de la cuenta; estas alertas no se pueden desactivar.",
    },
    de: {
      subject: "Okami Sentinel: Ihr Konto wurde vorübergehend gesperrt",
      heading: "Konto vorübergehend gesperrt",
      body: "Es gab genügend Anmeldeversuche mit falschem Passwort, um Ihr Konto zeitweise zu sperren.",
      advice: "Waren Sie das nicht, ändern Sie Ihr Passwort nach Ablauf der Sperre und informieren Sie eine Administratorin oder einen Administrator.",
      at: "Gesperrt am", retry: "Nächster Versuch in",
      wait: (minutes) => (minutes === 1 ? "1 Minute" : `${minutes} Minuten`),
      action: "Mein Konto öffnen",
      reason: "Sie haben diese Nachricht erhalten, weil sie eine Sicherheitswarnung zu Ihrem Konto ist; solche Warnungen lassen sich nicht abschalten.",
    },
    fr: {
      subject: "Okami Sentinel : votre compte a été bloqué temporairement",
      heading: "Compte bloqué temporairement",
      body: "Il y a eu assez de tentatives de connexion avec un mauvais mot de passe pour bloquer votre compte pendant un moment.",
      advice: "Si ce n'était pas vous, changez votre mot de passe dès la fin du blocage et prévenez un administrateur.",
      at: "Heure du blocage", retry: "Nouvelle tentative dans",
      wait: (minutes) => (minutes === 1 ? "1 minute" : `${minutes} minutes`),
      action: "Ouvrir Mon compte",
      reason: "Vous recevez ce message parce qu'il s'agit d'une alerte de sécurité du compte ; ces alertes ne peuvent pas être désactivées.",
    },
  },
  build: (data, copy) => ({
    subject: copy.subject,
    heading: copy.heading,
    paragraphs: [copy.body, copy.advice],
    facts: [
      { label: copy.at, value: formatMoment(data.at) },
      { label: copy.retry, value: copy.wait(minutesUntil(data.retryAfterSeconds)) },
    ],
    action: { label: copy.action, path: ACCOUNT_PATH },
    reason: copy.reason,
  }),
});

// --------------------------------------------------------------------------
// account.password_changed
// --------------------------------------------------------------------------

const accountPasswordChanged = defineTemplate<"account.password_changed", {
  subject: string; heading: string; body: string; advice: string;
  at: string; action: string; reason: string;
}>({
  group: "account",
  copy: {
    "pt-BR": {
      subject: "Okami Sentinel: sua senha foi alterada",
      heading: "Sua senha foi alterada",
      body: "A senha da sua conta no Okami Sentinel acabou de ser alterada.",
      advice: "Se não foi você, procure um administrador imediatamente e peça uma nova redefinição.",
      at: "Horário", action: "Abrir Minha conta",
      reason: "Você recebeu esta mensagem porque ela é um alerta de segurança da conta; estes alertas não podem ser desligados.",
    },
    en: {
      subject: "Okami Sentinel: your password was changed",
      heading: "Your password was changed",
      body: "The password of your Okami Sentinel account has just been changed.",
      advice: "If this was not you, talk to an administrator right away and ask for another reset.",
      at: "Time", action: "Open My account",
      reason: "You received this message because it is an account security alert; these alerts cannot be turned off.",
    },
    es: {
      subject: "Okami Sentinel: tu contraseña cambió",
      heading: "Tu contraseña cambió",
      body: "La contraseña de tu cuenta de Okami Sentinel acaba de cambiar.",
      advice: "Si no fuiste tú, habla con un administrador de inmediato y pide otro restablecimiento.",
      at: "Hora", action: "Abrir Mi cuenta",
      reason: "Recibiste este mensaje porque es una alerta de seguridad de la cuenta; estas alertas no se pueden desactivar.",
    },
    de: {
      subject: "Okami Sentinel: Ihr Passwort wurde geändert",
      heading: "Ihr Passwort wurde geändert",
      body: "Das Passwort Ihres Okami-Sentinel-Kontos wurde gerade geändert.",
      advice: "Waren Sie das nicht, wenden Sie sich sofort an eine Administratorin oder einen Administrator und bitten Sie um ein neues Zurücksetzen.",
      at: "Zeitpunkt", action: "Mein Konto öffnen",
      reason: "Sie haben diese Nachricht erhalten, weil sie eine Sicherheitswarnung zu Ihrem Konto ist; solche Warnungen lassen sich nicht abschalten.",
    },
    fr: {
      subject: "Okami Sentinel : votre mot de passe a été modifié",
      heading: "Votre mot de passe a été modifié",
      body: "Le mot de passe de votre compte Okami Sentinel vient d'être modifié.",
      advice: "Si ce n'était pas vous, contactez immédiatement un administrateur et demandez une nouvelle réinitialisation.",
      at: "Heure", action: "Ouvrir Mon compte",
      reason: "Vous recevez ce message parce qu'il s'agit d'une alerte de sécurité du compte ; ces alertes ne peuvent pas être désactivées.",
    },
  },
  build: (data, copy) => ({
    subject: copy.subject,
    heading: copy.heading,
    paragraphs: [copy.body, copy.advice],
    facts: [{ label: copy.at, value: formatMoment(data.at) }],
    action: { label: copy.action, path: ACCOUNT_PATH },
    reason: copy.reason,
  }),
});

/**
 * The registry. Task 3 adds its repository and ops kinds here; the mapped type
 * makes a missing entry — or an entry for a kind that is not in the data map — a
 * compile error.
 */
const TEMPLATES: { [K in EmailMessageKind]: TemplateDefinition<K> } = {
  "account.test": accountTest,
  "account.invite": accountInvite,
  "account.reset": accountReset,
  "account.new_login": accountNewLogin,
  "account.locked": accountLocked,
  "account.password_changed": accountPasswordChanged,
};

export const EMAIL_MESSAGE_KINDS = Object.keys(TEMPLATES) as EmailMessageKind[];

export function emailMessageGroup(kind: EmailMessageKind): EmailMessageGroup {
  return TEMPLATES[kind].group;
}

export interface RenderEmailInput<K extends EmailMessageKind> {
  kind: K;
  data: EmailMessageDataMap[K];
  locale: UserLocale;
  /** `null` in local mode: the message then names no link at all. */
  origin: string | null;
}

/**
 * The shell. Table layout, inline styles, no external stylesheet and no script,
 * because a mail client will strip or ignore all three; a plain-text twin is
 * always produced, because some clients only show that one.
 */
export function renderEmail<K extends EmailMessageKind>(input: RenderEmailInput<K>): RenderedEmail {
  const shell = SHELL[input.locale];
  const body = TEMPLATES[input.kind].build(input.data, input.locale);
  const footerPath = emailMessageGroup(input.kind) === "account" ? ACCOUNT_PATH : NOTIFICATIONS_PATH;
  const footerLabel = footerPath === ACCOUNT_PATH ? shell.accountLink : shell.notificationsLink;
  // A relative link is dead in a mail client, so without a public origin the
  // message carries no link and the footer says why instead of pretending.
  const url = (path: string): string | null => (input.origin === null ? null : `${input.origin}${path}`);
  const actionUrl = body.action === null ? null : url(body.action.path);
  const footerUrl = url(footerPath);

  const text = [
    shell.brand,
    "",
    body.heading,
    "",
    ...body.paragraphs.flatMap((paragraph) => [paragraph, ""]),
    ...body.facts.map((fact) => `${fact.label}: ${fact.value}`),
    ...(body.action !== null && actionUrl !== null ? ["", `${body.action.label}: ${actionUrl}`] : []),
    "",
    "--",
    `${shell.why}: ${body.reason}`,
    footerUrl === null ? shell.noLinks : `${footerLabel}: ${footerUrl}`,
  ].join("\n");

  const factsHtml = body.facts.length === 0 ? "" : [
    `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:20px 0 0;border-collapse:collapse">`,
    ...body.facts.map((fact) => [
      `<tr>`,
      `<td style="padding:2px 12px 2px 0;font-size:13px;line-height:1.6;color:#a8a29e;white-space:nowrap">${escapeHtml(fact.label)}</td>`,
      `<td style="padding:2px 0;font-size:13px;line-height:1.6;color:#1c1917">${escapeHtml(fact.value)}</td>`,
      `</tr>`,
    ].join("")),
    `</table>`,
  ].join("");

  const actionHtml = body.action === null || actionUrl === null
    ? ""
    : `<p style="margin:24px 0 0"><a href="${escapeHtml(actionUrl)}" style="color:#b45309;font-weight:600;text-decoration:none">${escapeHtml(body.action.label)}</a></p>`;

  const footerHtml = footerUrl === null
    ? `<p style="margin:8px 0 0">${escapeHtml(shell.noLinks)}</p>`
    : `<p style="margin:8px 0 0"><a href="${escapeHtml(footerUrl)}" style="color:#a8a29e;text-decoration:underline">${escapeHtml(footerLabel)}</a></p>`;

  const html = [
    `<!doctype html><html lang="${escapeHtml(input.locale)}"><body style="margin:0;padding:24px;background:#f5f5f4;font-family:ui-sans-serif,system-ui,'Segoe UI',Roboto,sans-serif;color:#1c1917">`,
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #e7e5e4;border-radius:12px"><tr><td style="padding:28px">`,
    `<p style="margin:0 0 16px;font-size:12px;letter-spacing:.12em;text-transform:uppercase;color:#a8a29e">${escapeHtml(shell.brand)}</p>`,
    `<h1 style="margin:0 0 12px;font-size:20px;line-height:1.3">${escapeHtml(body.heading)}</h1>`,
    ...body.paragraphs.map((paragraph) =>
      `<p style="margin:0 0 12px;font-size:14px;line-height:1.6">${escapeHtml(paragraph)}</p>`),
    factsHtml,
    actionHtml,
    `</td></tr><tr><td style="padding:0 28px 24px;font-size:12px;line-height:1.5;color:#a8a29e">`,
    `<p style="margin:0"><strong style="color:#78716c">${escapeHtml(shell.why)}</strong> ${escapeHtml(body.reason)}</p>`,
    footerHtml,
    `</td></tr></table>`,
    `</body></html>`,
  ].join("");

  return { subject: body.subject, html, text };
}

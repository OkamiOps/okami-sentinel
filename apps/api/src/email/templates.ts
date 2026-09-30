import {
  type ConnectionStatus,
  type GateOutcome,
  type SeverityCounts,
  type UserLocale,
} from "@csb/shared";

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
/**
 * What a repository email says about a gate. Counts, money, time and a link —
 * never a finding title, a file path, a code excerpt or a piece of evidence: the
 * design forbids it, and an inbox is the one place a reader cannot choose not to
 * look.
 */
export interface GateEmailData {
  gateId: string;
  /** The repository's display name, never its filesystem path. */
  repository: string;
  branch: string;
  pullRequest: number | null;
  outcome: GateOutcome;
  /** `null` when the gate decided without a scan (an empty change set). */
  severity: SeverityCounts | null;
  costUsd: number | null;
  durationMs: number | null;
}

/** The same rules, for a scan that reached a terminal status. */
export interface ScanEmailData {
  scanId: string;
  /**
   * The repository's display name, or `null` for a scan that belongs to no
   * repository — a local directory scan, whose only name is the directory's, which
   * is host information and stays out of the inbox.
   */
  repository: string | null;
  /** The revision the scan ran against, when one was recorded. */
  branch: string | null;
  status: "completed" | "failed" | "incomplete";
  severity: SeverityCounts | null;
  costUsd: number | null;
  durationMs: number | null;
}

export interface OpsEngineUnavailableData {
  /** When the condition started, which is what the six-hour window is measured from. */
  since: Date;
  at: Date;
  /** Engine ids, so the alert names what is down without naming the host. */
  engines: readonly string[];
}

export interface OpsConnectionAttentionData {
  connectionName: string;
  status: ConnectionStatus;
  since: Date;
  at: Date;
}

export interface OpsDailyCostData {
  repository: string;
  /** The UTC day the ceiling belongs to, as `YYYY-MM-DD`. */
  day: string;
  /** 80 or 100: which crossing this message is about. */
  percent: 80 | 100;
  reservedUsd: number;
  ceilingUsd: number;
}

export interface OpsPublishFailedData {
  gateId: string;
  repository: string;
  branch: string;
  /** The publish error as recorded on the gate row; a code or a provider message. */
  reason: string;
  at: Date;
}

/** The "it is over" twin of a condition alert. */
export interface OpsResolvedData {
  since: Date;
  at: Date;
}

export interface OpsConnectionResolvedData extends OpsResolvedData {
  connectionName: string;
}

export interface OpsPublishResolvedData extends OpsResolvedData {
  gateId: string;
  repository: string;
}

export interface EmailMessageDataMap {
  /** The one message an administrator sends on purpose, from the settings screen. */
  "account.test": { to: string; at: Date };
  "account.invite": { inviterName: string | null; inviteToken: string; expiresAt: Date };
  "account.reset": { resetToken: string; expiresAt: Date };
  "account.new_login": { at: Date; ip: string | null; browser: string | null };
  "account.locked": { at: Date; retryAfterSeconds: number };
  "account.password_changed": { at: Date };
  "gate.blocked": GateEmailData;
  "gate.error": GateEmailData;
  /** Passed, with or without warnings; the body says which. */
  "gate.passed": GateEmailData;
  "scan.failed": ScanEmailData;
  "scan.completed": ScanEmailData;
  "ops.engine_unavailable": OpsEngineUnavailableData;
  "ops.engine_unavailable.resolved": OpsResolvedData;
  "ops.connection_attention": OpsConnectionAttentionData;
  "ops.connection_attention.resolved": OpsConnectionResolvedData;
  "ops.daily_cost": OpsDailyCostData;
  "ops.github_publish_failed": OpsPublishFailedData;
  "ops.github_publish_failed.resolved": OpsPublishResolvedData;
}

export type EmailMessageKind = keyof EmailMessageDataMap;

/**
 * Which footer a message gets. Account messages cannot be turned off, so their
 * footer points at Minha conta; everything else points at the subscription
 * matrix the recipient can actually act on.
 */
export type EmailMessageGroup = "account" | "repository" | "ops";

/**
 * The colour a message is read in. One of five, never free-form, because the
 * shell turns it into a rule, a pill and a set of dark-mode overrides, and a
 * sixth tone would mean a sixth branch in each of them.
 */
export type EmailTone = "danger" | "success" | "warning" | "info" | "neutral";

/**
 * The word in the status pill. The key is what the code names; the tone and the
 * five translations live in `STATUS_TONES` and `SHELL[locale].statuses`, so a
 * message's colour and its label can never be decided in two different places.
 */
export type EmailStatusKey =
  | "test" | "invite" | "reset" | "new_login" | "locked" | "password_changed"
  | "blocked" | "error" | "passed" | "warned" | "scan_failed" | "completed"
  | "unavailable" | "attention" | "ceiling" | "ceiling_reached" | "publish_failed"
  | "resolved";

const STATUS_TONES: Readonly<Record<EmailStatusKey, EmailTone>> = Object.freeze({
  test: "info", invite: "info", reset: "info",
  new_login: "warning", locked: "warning", password_changed: "neutral",
  blocked: "danger", error: "danger", passed: "success", warned: "warning",
  scan_failed: "danger", completed: "success",
  unavailable: "danger", attention: "warning", ceiling: "warning",
  ceiling_reached: "danger", publish_failed: "danger", resolved: "success",
});

export function emailStatusTone(status: EmailStatusKey): EmailTone {
  return STATUS_TONES[status];
}

/**
 * The app module a message belongs to. The eyebrow prints the module's real
 * code — the numbered navigation is the product's grammar, and an invented
 * section number would be the one part of the e-mail the app could contradict.
 */
export type EmailSectionKey = "runs" | "guardrails" | "github" | "connections" | "account" | "email";

const SECTION_CODES: Readonly<Record<EmailSectionKey, string>> = Object.freeze({
  runs: "02", guardrails: "03", github: "04",
  connections: "08.02", account: "08.05", email: "08.06",
});

/**
 * The four severity counts a repository message shows as chips. It carries the
 * labels it was built with so the shell can render them as chips *and* drop the
 * four plain rows that would otherwise repeat them in the key/value panel; the
 * plain-text twin keeps those rows, because it has no chips.
 */
export interface EmailSeverityBlock {
  counts: { critical: number; high: number; medium: number; low: number };
  labels: { critical: string; high: string; medium: string; low: string };
}

/**
 * What a repository or connection message is about, given the prominence a fact
 * row cannot give it: the name large, the branch and the pull request as tags.
 * The labels ride along for the plain-text twin, which has no typography.
 */
export interface EmailTarget {
  label: string;
  name: string;
  chips: Array<{ label: string; value: string; kind: "accent" | "neutral" }>;
}

/** What a template produces; the shell turns this into HTML and text. */
export interface EmailTemplateBody {
  subject: string;
  heading: string;
  paragraphs: string[];
  /** The subject of the message — a repository, a scan, a connection. */
  target?: EmailTarget | null;
  /** Label/value pairs: the time, the address, the counts. Never evidence. */
  facts: Array<{ label: string; value: string }>;
  /** Counts worth a chip row, or `null` when the message has no scan behind it. */
  severity: EmailSeverityBlock | null;
  /** A path, never a URL: the shell owns the origin and the local-mode rule. */
  action: { label: string; path: string } | null;
  /** Why this message reached this person, in their language. */
  reason: string;
  /**
   * Overrides the kind's default status when the data, not the kind, decides:
   * a gate that passed with warnings, a ceiling crossed rather than approached.
   */
  status?: EmailStatusKey;
}

interface TemplateDefinition<K extends EmailMessageKind> {
  group: EmailMessageGroup;
  status: EmailStatusKey;
  /** The app module the eyebrow names; see `SECTION_CODES`. */
  section: EmailSectionKey;
  build(data: EmailMessageDataMap[K], locale: UserLocale): EmailTemplateBody;
}

/**
 * Binds one kind's per-locale copy to one builder. The copy type is inferred
 * from the table, so a locale missing a string the builder uses is a type error
 * rather than an `undefined` in someone's inbox.
 */
function defineTemplate<K extends EmailMessageKind, C>(definition: {
  group: EmailMessageGroup;
  status: EmailStatusKey;
  section: EmailSectionKey;
  copy: Readonly<Record<UserLocale, C>>;
  build(data: EmailMessageDataMap[K], copy: C): EmailTemplateBody;
}): TemplateDefinition<K> {
  return {
    group: definition.group,
    status: definition.status,
    section: definition.section,
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

/**
 * The last pass over the finished HTML document, turning every non-ASCII code
 * point into a numeric character reference. Resend stores the message as
 * UTF-8 and the document declares `<meta charset="utf-8">`, but at least one
 * mail client decodes the HTML part as Latin-1 regardless of that
 * declaration, which turns "está" into "estÃ¡". A document that is pure
 * 7-bit ASCII cannot be mis-decoded by any single-byte charset, so this runs
 * last, over the whole string — text nodes, attributes, the VML block MSO
 * reads, the preheader — everything except `subject` and `text`, which no
 * mail client renders as HTML and therefore cannot mis-decode this way.
 * `codePointAt` keeps an astral character (outside the BMP) as one reference
 * rather than splitting its surrogate pair into two.
 */
export function toAsciiEntities(value: string): string {
  return value.replace(/[^\x00-\x7F]/gu, (character) => `&#${character.codePointAt(0)};`);
}

// --------------------------------------------------------------------------
// The shell's own copy: brand line, footer and the local-mode notice.
// --------------------------------------------------------------------------

interface ShellCopy {
  brand: string;
  /** The footer's link, as an action rather than as the name of a page. */
  accountAction: string;
  notificationsAction: string;
  /** Said instead of a link when the installation has no public address. */
  noLinks: string;
  /** The eyebrow in the dark header band: which family the message belongs to. */
  groups: Readonly<Record<EmailMessageGroup, string>>;
  /** The status word, already upper-cased: the hero never wraps copy. */
  statuses: Readonly<Record<EmailStatusKey, string>>;
  /**
   * The app section a message's eyebrow names, spelled the way the interface
   * spells it. The numbers come from the real navigation — `nav` in
   * `apps/web/src/App.tsx` and `sections` in `SettingsSectionNav.tsx` — so an
   * eyebrow can never name a module the app does not have.
   */
  sections: Readonly<Record<EmailSectionKey, string>>;
  /** The word before the timestamp in the signature strip. */
  reading: string;
  /** The last line of the footer. */
  signature: string;
}

const SHELL: Readonly<Record<UserLocale, ShellCopy>> = Object.freeze({
  "pt-BR": {
    brand: "Okami Sentinel",
    accountAction: "Abrir minha conta",
    notificationsAction: "Gerenciar notificações",
    noLinks: "Esta instalação não tem endereço público configurado, por isso esta mensagem não traz links.",
    groups: { account: "Conta", repository: "Repositório", ops: "Operação" },
    statuses: {
      test: "TESTE", invite: "CONVITE", reset: "REDEFINIÇÃO",
      new_login: "NOVO ACESSO", locked: "CONTA BLOQUEADA", password_changed: "SENHA ALTERADA",
      blocked: "BLOQUEADO", error: "ERRO", passed: "APROVADO", warned: "COM AVISO",
      scan_failed: "FALHOU", completed: "CONCLUÍDO",
      unavailable: "INDISPONÍVEL", attention: "ATENÇÃO", ceiling: "80% DO TETO",
      ceiling_reached: "TETO ATINGIDO", publish_failed: "NÃO PUBLICADO", resolved: "RESOLVIDO",
    },
    sections: { runs: "Runs", guardrails: "Guardrails", github: "GitHub", connections: "Conexões", account: "Conta", email: "E-mail" },
    reading: "LEITURA",
    signature: "Okami Sentinel · OkamiLab",
  },
  en: {
    brand: "Okami Sentinel",
    accountAction: "Open my account",
    notificationsAction: "Manage notifications",
    noLinks: "This installation has no public address configured, so this message carries no links.",
    groups: { account: "Account", repository: "Repository", ops: "Operations" },
    statuses: {
      test: "TEST", invite: "INVITATION", reset: "PASSWORD RESET",
      new_login: "NEW SIGN-IN", locked: "ACCOUNT LOCKED", password_changed: "PASSWORD CHANGED",
      blocked: "BLOCKED", error: "ERROR", passed: "PASSED", warned: "WARNINGS",
      scan_failed: "FAILED", completed: "COMPLETED",
      unavailable: "UNAVAILABLE", attention: "NEEDS ATTENTION", ceiling: "80% OF CEILING",
      ceiling_reached: "CEILING REACHED", publish_failed: "NOT PUBLISHED", resolved: "RESOLVED",
    },
    sections: { runs: "Runs", guardrails: "Guardrails", github: "GitHub", connections: "Connections", account: "Account", email: "E-mail" },
    reading: "READ",
    signature: "Okami Sentinel · OkamiLab",
  },
  es: {
    brand: "Okami Sentinel",
    accountAction: "Abrir mi cuenta",
    notificationsAction: "Gestionar notificaciones",
    noLinks: "Esta instalación no tiene una dirección pública configurada, por eso este mensaje no incluye enlaces.",
    groups: { account: "Cuenta", repository: "Repositorio", ops: "Operación" },
    statuses: {
      test: "PRUEBA", invite: "INVITACIÓN", reset: "RESTABLECER",
      new_login: "NUEVO ACCESO", locked: "CUENTA BLOQUEADA", password_changed: "CONTRASEÑA CAMBIADA",
      blocked: "BLOQUEADO", error: "ERROR", passed: "APROBADO", warned: "CON AVISOS",
      scan_failed: "FALLÓ", completed: "COMPLETADO",
      unavailable: "NO DISPONIBLE", attention: "ATENCIÓN", ceiling: "80% DEL TECHO",
      ceiling_reached: "TECHO ALCANZADO", publish_failed: "NO PUBLICADO", resolved: "RESUELTO",
    },
    sections: { runs: "Runs", guardrails: "Guardrails", github: "GitHub", connections: "Conexiones", account: "Cuenta", email: "E-mail" },
    reading: "LECTURA",
    signature: "Okami Sentinel · OkamiLab",
  },
  de: {
    brand: "Okami Sentinel",
    accountAction: "Mein Konto öffnen",
    notificationsAction: "Benachrichtigungen verwalten",
    noLinks: "Für diese Installation ist keine öffentliche Adresse konfiguriert, daher enthält diese Nachricht keine Links.",
    groups: { account: "Konto", repository: "Repository", ops: "Betrieb" },
    statuses: {
      test: "TEST", invite: "EINLADUNG", reset: "PASSWORT ZURÜCKSETZEN",
      new_login: "NEUE ANMELDUNG", locked: "KONTO GESPERRT", password_changed: "PASSWORT GEÄNDERT",
      blocked: "BLOCKIERT", error: "FEHLER", passed: "BESTANDEN", warned: "MIT WARNUNGEN",
      scan_failed: "FEHLGESCHLAGEN", completed: "ABGESCHLOSSEN",
      unavailable: "NICHT VERFÜGBAR", attention: "ACHTUNG", ceiling: "80 % DER GRENZE",
      ceiling_reached: "GRENZE ERREICHT", publish_failed: "NICHT VERÖFFENTLICHT", resolved: "BEHOBEN",
    },
    sections: { runs: "Runs", guardrails: "Guardrails", github: "GitHub", connections: "Verbindungen", account: "Konto", email: "E-Mail" },
    reading: "STAND",
    signature: "Okami Sentinel · OkamiLab",
  },
  fr: {
    brand: "Okami Sentinel",
    accountAction: "Ouvrir mon compte",
    notificationsAction: "Gérer les notifications",
    noLinks: "Cette installation n'a pas d'adresse publique configurée, ce message ne contient donc aucun lien.",
    groups: { account: "Compte", repository: "Dépôt", ops: "Exploitation" },
    statuses: {
      test: "TEST", invite: "INVITATION", reset: "RÉINITIALISATION",
      new_login: "NOUVELLE CONNEXION", locked: "COMPTE BLOQUÉ", password_changed: "MOT DE PASSE MODIFIÉ",
      blocked: "BLOQUÉ", error: "ERREUR", passed: "VALIDÉ", warned: "AVEC AVERTISSEMENTS",
      scan_failed: "ÉCHEC", completed: "TERMINÉ",
      unavailable: "INDISPONIBLE", attention: "ATTENTION", ceiling: "80 % DU PLAFOND",
      ceiling_reached: "PLAFOND ATTEINT", publish_failed: "NON PUBLIÉ", resolved: "RÉSOLU",
    },
    sections: { runs: "Runs", guardrails: "Guardrails", github: "GitHub", connections: "Connexions", account: "Compte", email: "E-mail" },
    reading: "LECTURE",
    signature: "Okami Sentinel · OkamiLab",
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
  status: "test",
  section: "email",
  copy: {
    "pt-BR": {
      subject: "Okami Sentinel: e-mail de teste",
      heading: "O e-mail está funcionando",
      body: "Este é um envio de teste feito nas configurações do Okami Sentinel. Se você recebeu esta mensagem, o provedor está configurado corretamente.",
      sentTo: "Enviado para", at: "Horário",
      action: "Abrir as configurações de e-mail",
      reason: "Você recebe este e-mail porque um administrador pediu um envio de teste.",
    },
    en: {
      subject: "Okami Sentinel: test e-mail",
      heading: "E-mail is working",
      body: "This is a test send from the Okami Sentinel settings. If this message reached you, the provider is configured correctly.",
      sentTo: "Sent to", at: "Sent at",
      action: "Open the e-mail settings",
      reason: "You receive this e-mail because an administrator asked for a test send.",
    },
    es: {
      subject: "Okami Sentinel: correo de prueba",
      heading: "El correo funciona",
      body: "Este es un envío de prueba desde la configuración de Okami Sentinel. Si recibiste este mensaje, el proveedor está configurado correctamente.",
      sentTo: "Enviado a", at: "Hora",
      action: "Abrir la configuración de correo",
      reason: "Recibes este correo porque un administrador solicitó un envío de prueba.",
    },
    de: {
      subject: "Okami Sentinel: Test-E-Mail",
      heading: "Der E-Mail-Versand funktioniert",
      body: "Dies ist ein Testversand aus den Einstellungen von Okami Sentinel. Wenn diese Nachricht angekommen ist, ist der Anbieter korrekt konfiguriert.",
      sentTo: "Gesendet an", at: "Gesendet am",
      action: "E-Mail-Einstellungen öffnen",
      reason: "Sie erhalten diese E-Mail, weil ein Testversand angefordert wurde.",
    },
    fr: {
      subject: "Okami Sentinel : e-mail de test",
      heading: "L'envoi d'e-mails fonctionne",
      body: "Ceci est un envoi de test effectué depuis les paramètres d'Okami Sentinel. Si vous avez reçu ce message, le fournisseur est correctement configuré.",
      sentTo: "Envoyé à", at: "Envoyé le",
      action: "Ouvrir les paramètres d'e-mail",
      reason: "Vous recevez cet e-mail parce qu'un administrateur a demandé un envoi de test.",
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
    severity: null,
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
  status: "invite",
  section: "account",
  copy: {
    "pt-BR": {
      subject: "Okami Sentinel: seu convite de acesso",
      heading: "Você foi convidado ao Okami Sentinel",
      byName: (name) => `${name} criou uma conta para você no Okami Sentinel.`,
      byAdmin: "Um administrador criou uma conta para você no Okami Sentinel.",
      next: "Para entrar, defina uma senha usando o link do convite. Ele vale uma única vez.",
      expires: "Expira em", action: "Definir minha senha",
      reason: "Você recebe este e-mail porque uma conta foi criada para você no Okami Sentinel. Se você não esperava este convite, pode ignorá-lo.",
    },
    en: {
      subject: "Okami Sentinel: your access invitation",
      heading: "You have been invited to Okami Sentinel",
      byName: (name) => `${name} created an account for you on Okami Sentinel.`,
      byAdmin: "An administrator created an account for you on Okami Sentinel.",
      next: "To sign in, set a password using the invitation link. It works once.",
      expires: "Expires at", action: "Set my password",
      reason: "You receive this e-mail because an account was created for you on Okami Sentinel. If you were not expecting this invitation, you can ignore it.",
    },
    es: {
      subject: "Okami Sentinel: tu invitación de acceso",
      heading: "Te invitaron a Okami Sentinel",
      byName: (name) => `${name} creó una cuenta para ti en Okami Sentinel.`,
      byAdmin: "Un administrador creó una cuenta para ti en Okami Sentinel.",
      next: "Para entrar, define una contraseña con el enlace de la invitación. Sirve una sola vez.",
      expires: "Expira el", action: "Definir mi contraseña",
      reason: "Recibes este correo porque se creó una cuenta para ti en Okami Sentinel. Si no esperabas esta invitación, puedes ignorarla.",
    },
    de: {
      subject: "Okami Sentinel: Ihre Zugangseinladung",
      heading: "Sie wurden zu Okami Sentinel eingeladen",
      byName: (name) => `${name} hat ein Konto für Sie in Okami Sentinel angelegt.`,
      byAdmin: "Eine Administratorin oder ein Administrator hat ein Konto für Sie in Okami Sentinel angelegt.",
      next: "Legen Sie zum Anmelden über den Einladungslink ein Passwort fest. Der Link gilt einmalig.",
      expires: "Läuft ab am", action: "Passwort festlegen",
      reason: "Sie erhalten diese E-Mail, weil in Okami Sentinel ein Konto für Sie angelegt wurde. Wenn Sie diese Einladung nicht erwartet haben, können Sie sie ignorieren.",
    },
    fr: {
      subject: "Okami Sentinel : votre invitation d'accès",
      heading: "Vous avez été invité à Okami Sentinel",
      byName: (name) => `${name} a créé un compte pour vous dans Okami Sentinel.`,
      byAdmin: "Un administrateur a créé un compte pour vous dans Okami Sentinel.",
      next: "Pour vous connecter, définissez un mot de passe avec le lien d'invitation. Il ne fonctionne qu'une fois.",
      expires: "Expire le", action: "Définir mon mot de passe",
      reason: "Vous recevez cet e-mail parce qu'un compte a été créé pour vous dans Okami Sentinel. Si vous n'attendiez pas cette invitation, vous pouvez l'ignorer.",
    },
  },
  build: (data, copy) => ({
    subject: copy.subject,
    heading: copy.heading,
    paragraphs: [data.inviterName ? copy.byName(data.inviterName) : copy.byAdmin, copy.next],
    facts: [{ label: copy.expires, value: formatMoment(data.expiresAt) }],
    severity: null,
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
  status: "reset",
  section: "account",
  copy: {
    "pt-BR": {
      subject: "Okami Sentinel: redefinição de senha",
      heading: "Defina uma nova senha",
      body: "Um administrador criou um link para você escolher uma nova senha no Okami Sentinel.",
      sessions: "Suas sessões abertas foram encerradas. Se não foi você que pediu isto, procure um administrador.",
      expires: "Expira em", action: "Definir uma nova senha",
      reason: "Você recebe este e-mail porque um administrador pediu a redefinição da sua senha.",
    },
    en: {
      subject: "Okami Sentinel: password reset",
      heading: "Set a new password",
      body: "An administrator created a link for you to choose a new password on Okami Sentinel.",
      sessions: "Your open sessions were signed out. If you did not ask for this, talk to an administrator.",
      expires: "Expires at", action: "Set a new password",
      reason: "You receive this e-mail because an administrator asked for your password to be reset.",
    },
    es: {
      subject: "Okami Sentinel: restablecer la contraseña",
      heading: "Define una nueva contraseña",
      body: "Un administrador creó un enlace para que elijas una nueva contraseña en Okami Sentinel.",
      sessions: "Tus sesiones abiertas se cerraron. Si no pediste esto, habla con un administrador.",
      expires: "Expira el", action: "Definir una nueva contraseña",
      reason: "Recibes este correo porque un administrador solicitó restablecer tu contraseña.",
    },
    de: {
      subject: "Okami Sentinel: Passwort zurücksetzen",
      heading: "Neues Passwort festlegen",
      body: "Eine Administratorin oder ein Administrator hat einen Link erstellt, mit dem Sie in Okami Sentinel ein neues Passwort wählen.",
      sessions: "Ihre offenen Sitzungen wurden beendet. Wenn Sie das nicht angefordert haben, wenden Sie sich an eine Administratorin oder einen Administrator.",
      expires: "Läuft ab am", action: "Neues Passwort festlegen",
      reason: "Sie erhalten diese E-Mail, weil das Zurücksetzen Ihres Passworts angefordert wurde.",
    },
    fr: {
      subject: "Okami Sentinel : réinitialisation du mot de passe",
      heading: "Définissez un nouveau mot de passe",
      body: "Un administrateur a créé un lien pour que vous choisissiez un nouveau mot de passe dans Okami Sentinel.",
      sessions: "Vos sessions ouvertes ont été fermées. Si vous n'avez rien demandé, contactez un administrateur.",
      expires: "Expire le", action: "Définir un nouveau mot de passe",
      reason: "Vous recevez cet e-mail parce qu'un administrateur a demandé la réinitialisation de votre mot de passe.",
    },
  },
  build: (data, copy) => ({
    subject: copy.subject,
    heading: copy.heading,
    paragraphs: [copy.body, copy.sessions],
    facts: [{ label: copy.expires, value: formatMoment(data.expiresAt) }],
    severity: null,
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
  status: "new_login",
  section: "account",
  copy: {
    "pt-BR": {
      subject: "Okami Sentinel: novo acesso à sua conta",
      heading: "Novo acesso à sua conta",
      body: "Sua conta foi acessada de um endereço e navegador que ainda não apareciam nas suas sessões recentes.",
      advice: "Se foi você, não há nada a fazer. Se não foi, troque sua senha e encerre as outras sessões em Minha conta.",
      at: "Horário", ip: "Endereço IP", browser: "Navegador", unknown: "não registrado",
      action: "Abrir Minha conta",
      reason: "Você recebe este e-mail porque ele é um alerta de segurança da conta, e esses alertas não podem ser desligados.",
    },
    en: {
      subject: "Okami Sentinel: new sign-in to your account",
      heading: "New sign-in to your account",
      body: "Your account was accessed from an address and browser that had not appeared in your recent sessions.",
      advice: "If this was you, there is nothing to do. If it was not, change your password and sign out the other sessions in My account.",
      at: "Time", ip: "IP address", browser: "Browser", unknown: "not recorded",
      action: "Open My account",
      reason: "You receive this e-mail because it is an account security alert, and those cannot be turned off.",
    },
    es: {
      subject: "Okami Sentinel: nuevo acceso a tu cuenta",
      heading: "Nuevo acceso a tu cuenta",
      body: "Se accedió a tu cuenta desde una dirección y un navegador que no aparecían en tus sesiones recientes.",
      advice: "Si fuiste tú, no hay nada que hacer. Si no, cambia tu contraseña y cierra las otras sesiones en Mi cuenta.",
      at: "Hora", ip: "Dirección IP", browser: "Navegador", unknown: "no registrado",
      action: "Abrir Mi cuenta",
      reason: "Recibes este correo porque es una alerta de seguridad de la cuenta, y esas no se pueden desactivar.",
    },
    de: {
      subject: "Okami Sentinel: neue Anmeldung an Ihrem Konto",
      heading: "Neue Anmeldung an Ihrem Konto",
      body: "Auf Ihr Konto wurde von einer Adresse und einem Browser zugegriffen, die in Ihren letzten Sitzungen nicht vorkamen.",
      advice: "Waren Sie das, ist nichts zu tun. Andernfalls ändern Sie Ihr Passwort und beenden Sie die übrigen Sitzungen unter Mein Konto.",
      at: "Zeitpunkt", ip: "IP-Adresse", browser: "Browser", unknown: "nicht erfasst",
      action: "Mein Konto öffnen",
      reason: "Sie erhalten diese E-Mail, weil sie eine Sicherheitswarnung zu Ihrem Konto ist; solche Warnungen lassen sich nicht abschalten.",
    },
    fr: {
      subject: "Okami Sentinel : nouvelle connexion à votre compte",
      heading: "Nouvelle connexion à votre compte",
      body: "Votre compte a été utilisé depuis une adresse et un navigateur absents de vos sessions récentes.",
      advice: "Si c'était vous, il n'y a rien à faire. Sinon, changez votre mot de passe et fermez les autres sessions dans Mon compte.",
      at: "Heure", ip: "Adresse IP", browser: "Navigateur", unknown: "non enregistré",
      action: "Ouvrir Mon compte",
      reason: "Vous recevez cet e-mail parce qu'il s'agit d'une alerte de sécurité du compte, et ces alertes ne peuvent pas être désactivées.",
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
    severity: null,
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
  status: "locked",
  section: "account",
  copy: {
    "pt-BR": {
      subject: "Okami Sentinel: sua conta foi bloqueada temporariamente",
      heading: "Conta bloqueada temporariamente",
      body: "Houve tentativas de login suficientes com a senha errada para bloquear sua conta por um período.",
      advice: "Se não foi você tentando entrar, troque sua senha assim que o bloqueio terminar e avise um administrador.",
      at: "Horário", retry: "Nova tentativa",
      wait: (minutes) => (minutes === 1 ? "1 minuto" : `${minutes} minutos`),
      action: "Abrir Minha conta",
      reason: "Você recebe este e-mail porque ele é um alerta de segurança da conta, e esses alertas não podem ser desligados.",
    },
    en: {
      subject: "Okami Sentinel: your account was locked temporarily",
      heading: "Account locked temporarily",
      body: "There were enough sign-in attempts with the wrong password to lock your account for a while.",
      advice: "If it was not you trying to sign in, change your password as soon as the lock ends and tell an administrator.",
      at: "Locked at", retry: "Try again in",
      wait: (minutes) => (minutes === 1 ? "1 minute" : `${minutes} minutes`),
      action: "Open My account",
      reason: "You receive this e-mail because it is an account security alert, and those cannot be turned off.",
    },
    es: {
      subject: "Okami Sentinel: tu cuenta se bloqueó temporalmente",
      heading: "Cuenta bloqueada temporalmente",
      body: "Hubo suficientes intentos de inicio de sesión con la contraseña incorrecta para bloquear tu cuenta por un tiempo.",
      advice: "Si no fuiste tú, cambia tu contraseña en cuanto termine el bloqueo y avisa a un administrador.",
      at: "Hora", retry: "Reintentar en",
      wait: (minutes) => (minutes === 1 ? "1 minuto" : `${minutes} minutos`),
      action: "Abrir Mi cuenta",
      reason: "Recibes este correo porque es una alerta de seguridad de la cuenta, y esas no se pueden desactivar.",
    },
    de: {
      subject: "Okami Sentinel: Ihr Konto wurde vorübergehend gesperrt",
      heading: "Konto vorübergehend gesperrt",
      body: "Es gab genügend Anmeldeversuche mit falschem Passwort, um Ihr Konto zeitweise zu sperren.",
      advice: "Waren Sie das nicht, ändern Sie Ihr Passwort nach Ablauf der Sperre und informieren Sie eine Administratorin oder einen Administrator.",
      at: "Gesperrt am", retry: "Erneut in",
      wait: (minutes) => (minutes === 1 ? "1 Minute" : `${minutes} Minuten`),
      action: "Mein Konto öffnen",
      reason: "Sie erhalten diese E-Mail, weil sie eine Sicherheitswarnung zu Ihrem Konto ist; solche Warnungen lassen sich nicht abschalten.",
    },
    fr: {
      subject: "Okami Sentinel : votre compte a été bloqué temporairement",
      heading: "Compte bloqué temporairement",
      body: "Il y a eu assez de tentatives de connexion avec un mauvais mot de passe pour bloquer votre compte pendant un moment.",
      advice: "Si ce n'était pas vous, changez votre mot de passe dès la fin du blocage et prévenez un administrateur.",
      at: "Heure", retry: "Réessayer dans",
      wait: (minutes) => (minutes === 1 ? "1 minute" : `${minutes} minutes`),
      action: "Ouvrir Mon compte",
      reason: "Vous recevez cet e-mail parce qu'il s'agit d'une alerte de sécurité du compte, et ces alertes ne peuvent pas être désactivées.",
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
    severity: null,
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
  status: "password_changed",
  section: "account",
  copy: {
    "pt-BR": {
      subject: "Okami Sentinel: sua senha foi alterada",
      heading: "Sua senha foi alterada",
      body: "A senha da sua conta no Okami Sentinel acabou de ser alterada.",
      advice: "Se não foi você, procure um administrador imediatamente e peça uma nova redefinição.",
      at: "Horário", action: "Abrir Minha conta",
      reason: "Você recebe este e-mail porque ele é um alerta de segurança da conta, e esses alertas não podem ser desligados.",
    },
    en: {
      subject: "Okami Sentinel: your password was changed",
      heading: "Your password was changed",
      body: "The password of your Okami Sentinel account has just been changed.",
      advice: "If this was not you, talk to an administrator right away and ask for another reset.",
      at: "Time", action: "Open My account",
      reason: "You receive this e-mail because it is an account security alert, and those cannot be turned off.",
    },
    es: {
      subject: "Okami Sentinel: tu contraseña cambió",
      heading: "Tu contraseña cambió",
      body: "La contraseña de tu cuenta de Okami Sentinel acaba de cambiar.",
      advice: "Si no fuiste tú, habla con un administrador de inmediato y pide otro restablecimiento.",
      at: "Hora", action: "Abrir Mi cuenta",
      reason: "Recibes este correo porque es una alerta de seguridad de la cuenta, y esas no se pueden desactivar.",
    },
    de: {
      subject: "Okami Sentinel: Ihr Passwort wurde geändert",
      heading: "Ihr Passwort wurde geändert",
      body: "Das Passwort Ihres Okami-Sentinel-Kontos wurde gerade geändert.",
      advice: "Waren Sie das nicht, wenden Sie sich sofort an eine Administratorin oder einen Administrator und bitten Sie um ein neues Zurücksetzen.",
      at: "Zeitpunkt", action: "Mein Konto öffnen",
      reason: "Sie erhalten diese E-Mail, weil sie eine Sicherheitswarnung zu Ihrem Konto ist; solche Warnungen lassen sich nicht abschalten.",
    },
    fr: {
      subject: "Okami Sentinel : votre mot de passe a été modifié",
      heading: "Votre mot de passe a été modifié",
      body: "Le mot de passe de votre compte Okami Sentinel vient d'être modifié.",
      advice: "Si ce n'était pas vous, contactez immédiatement un administrateur et demandez une nouvelle réinitialisation.",
      at: "Heure", action: "Ouvrir Mon compte",
      reason: "Vous recevez cet e-mail parce qu'il s'agit d'une alerte de sécurité du compte, et ces alertes ne peuvent pas être désactivées.",
    },
  },
  build: (data, copy) => ({
    subject: copy.subject,
    heading: copy.heading,
    paragraphs: [copy.body, copy.advice],
    facts: [{ label: copy.at, value: formatMoment(data.at) }],
    severity: null,
    action: { label: copy.action, path: ACCOUNT_PATH },
    reason: copy.reason,
  }),
});

// --------------------------------------------------------------------------
// Repository events: the five results a repository can produce.
// --------------------------------------------------------------------------

/** `USD 0.42`, and four decimals while the number would otherwise round to zero. */
export function formatUsd(value: number): string {
  return `USD ${value > 0 && value < 0.01 ? value.toFixed(4) : value.toFixed(2)}`;
}

/**
 * `18 s`, `4m 07s`, `1h 12m`. No words, so the same string is correct in all five
 * languages and no translation can disagree with the number next to it.
 */
export function formatDurationShort(milliseconds: number): string {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return "-";
  if (milliseconds < 1_000) return `${Math.round(milliseconds)} ms`;
  const seconds = Math.round(milliseconds / 1_000);
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

interface RepositoryKindCopy {
  subject: (repository: string) => string;
  heading: string;
  body: string;
}

interface RepositoryCopy {
  repository: string;
  /**
   * The label a scan with no repository files itself under. Same word in all five
   * languages, and deliberately not `repository`: a local directory scan has a
   * scan id and nothing else, and printing that id as "Repository" is the one
   * thing a reader would then get wrong about it.
   */
  scan: string;
  branch: string;
  pullRequest: string;
  outcome: string;
  findings: string;
  critical: string;
  high: string;
  medium: string;
  low: string;
  cost: string;
  duration: string;
  outcomes: Readonly<Record<GateOutcome, string>>;
  statuses: Readonly<Record<ScanEmailData["status"], string>>;
  openGate: string;
  openScan: string;
  /** Why this message arrived, and where to turn it off. */
  reason: string;
  gateBlocked: RepositoryKindCopy;
  gateError: RepositoryKindCopy;
  gatePassed: RepositoryKindCopy;
  gateWarning: RepositoryKindCopy;
  scanFailed: RepositoryKindCopy;
  scanCompleted: RepositoryKindCopy;
}

const REPOSITORY_COPY: Readonly<Record<UserLocale, RepositoryCopy>> = Object.freeze({
  "pt-BR": {
    repository: "Repositório", scan: "Scan", branch: "Branch", pullRequest: "Pull request", outcome: "Resultado",
    findings: "Findings", critical: "Críticos", high: "Altos", medium: "Médios", low: "Baixos",
    cost: "Custo", duration: "Duração",
    outcomes: {
      no_changes: "sem mudanças", bootstrap: "linha de base", pass: "aprovado",
      warning: "aprovado com aviso", blocked: "bloqueado", error: "erro",
    },
    statuses: { completed: "concluído", failed: "falhou", incomplete: "incompleto" },
    openGate: "Abrir o gate", openScan: "Abrir o scan",
    reason: "Você recebe este e-mail porque assina os eventos deste repositório.",
    gateBlocked: {
      subject: (repository) => `Okami Sentinel: gate bloqueado em ${repository}`,
      heading: "O gate bloqueou a mudança",
      body: "A política do repositório bloqueou esta mudança. Abra o gate no Sentinel para ver a decisão e os findings.",
    },
    gateError: {
      subject: (repository) => `Okami Sentinel: erro no gate em ${repository}`,
      heading: "O gate terminou com erro",
      body: "O gate não conseguiu concluir a avaliação, por isso ele falha fechado e a mudança fica sem decisão. Abra o gate no Sentinel para ver o motivo.",
    },
    gatePassed: {
      subject: (repository) => `Okami Sentinel: gate aprovado em ${repository}`,
      heading: "O gate aprovou a mudança",
      body: "A política do repositório não encontrou motivo para bloquear esta mudança.",
    },
    gateWarning: {
      subject: (repository) => `Okami Sentinel: gate aprovado com aviso em ${repository}`,
      heading: "O gate aprovou com aviso",
      body: "A mudança passou, mas a política registrou avisos. Abra o gate no Sentinel para ver quais.",
    },
    scanFailed: {
      subject: (repository) => `Okami Sentinel: scan falhou em ${repository}`,
      heading: "O scan não terminou",
      body: "O scan terminou sem um resultado completo. Abra o scan no Sentinel para ver o que aconteceu.",
    },
    scanCompleted: {
      subject: (repository) => `Okami Sentinel: scan concluído em ${repository}`,
      heading: "O scan terminou",
      body: "O scan terminou e o resultado já está indexado no Sentinel.",
    },
  },
  en: {
    repository: "Repository", scan: "Scan", branch: "Branch", pullRequest: "Pull request", outcome: "Result",
    findings: "Findings", critical: "Critical", high: "High", medium: "Medium", low: "Low",
    cost: "Cost", duration: "Duration",
    outcomes: {
      no_changes: "no changes", bootstrap: "baseline", pass: "passed",
      warning: "passed with warnings", blocked: "blocked", error: "error",
    },
    statuses: { completed: "completed", failed: "failed", incomplete: "incomplete" },
    openGate: "Open the gate", openScan: "Open the scan",
    reason: "You receive this e-mail because you subscribe to this repository's events.",
    gateBlocked: {
      subject: (repository) => `Okami Sentinel: gate blocked on ${repository}`,
      heading: "The gate blocked the change",
      body: "The repository policy blocked this change. Open the gate in the Sentinel to see the decision and the findings.",
    },
    gateError: {
      subject: (repository) => `Okami Sentinel: gate error on ${repository}`,
      heading: "The gate ended in an error",
      body: "The gate could not finish its evaluation, so it fails closed and the change has no decision. Open the gate in the Sentinel to see why.",
    },
    gatePassed: {
      subject: (repository) => `Okami Sentinel: gate passed on ${repository}`,
      heading: "The gate passed the change",
      body: "The repository policy found no reason to block this change.",
    },
    gateWarning: {
      subject: (repository) => `Okami Sentinel: gate passed with warnings on ${repository}`,
      heading: "The gate passed with warnings",
      body: "The change went through, but the policy recorded warnings. Open the gate in the Sentinel to see them.",
    },
    scanFailed: {
      subject: (repository) => `Okami Sentinel: scan failed on ${repository}`,
      heading: "The scan did not finish",
      body: "The scan ended without a complete result. Open the scan in the Sentinel to see what happened.",
    },
    scanCompleted: {
      subject: (repository) => `Okami Sentinel: scan completed on ${repository}`,
      heading: "The scan finished",
      body: "The scan finished and its result is indexed in the Sentinel.",
    },
  },
  es: {
    repository: "Repositorio", scan: "Scan", branch: "Rama", pullRequest: "Pull request", outcome: "Resultado",
    findings: "Hallazgos", critical: "Críticos", high: "Altos", medium: "Medios", low: "Bajos",
    cost: "Costo", duration: "Duración",
    outcomes: {
      no_changes: "sin cambios", bootstrap: "línea base", pass: "aprobado",
      warning: "aprobado con avisos", blocked: "bloqueado", error: "error",
    },
    statuses: { completed: "completado", failed: "falló", incomplete: "incompleto" },
    openGate: "Abrir el gate", openScan: "Abrir el scan",
    reason: "Recibes este correo porque estás suscrito a los eventos de este repositorio.",
    gateBlocked: {
      subject: (repository) => `Okami Sentinel: gate bloqueado en ${repository}`,
      heading: "El gate bloqueó el cambio",
      body: "La política del repositorio bloqueó este cambio. Abre el gate en el Sentinel para ver la decisión y los hallazgos.",
    },
    gateError: {
      subject: (repository) => `Okami Sentinel: error del gate en ${repository}`,
      heading: "El gate terminó con error",
      body: "El gate no pudo terminar la evaluación, así que falla cerrado y el cambio queda sin decisión. Abre el gate en el Sentinel para ver el motivo.",
    },
    gatePassed: {
      subject: (repository) => `Okami Sentinel: gate aprobado en ${repository}`,
      heading: "El gate aprobó el cambio",
      body: "La política del repositorio no encontró motivo para bloquear este cambio.",
    },
    gateWarning: {
      subject: (repository) => `Okami Sentinel: gate aprobado con avisos en ${repository}`,
      heading: "El gate aprobó con avisos",
      body: "El cambio pasó, pero la política registró avisos. Abre el gate en el Sentinel para verlos.",
    },
    scanFailed: {
      subject: (repository) => `Okami Sentinel: el scan falló en ${repository}`,
      heading: "El scan no terminó",
      body: "El scan terminó sin un resultado completo. Abre el scan en el Sentinel para ver qué pasó.",
    },
    scanCompleted: {
      subject: (repository) => `Okami Sentinel: scan completado en ${repository}`,
      heading: "El scan terminó",
      body: "El scan terminó y su resultado ya está indexado en el Sentinel.",
    },
  },
  de: {
    repository: "Repository", scan: "Scan", branch: "Branch", pullRequest: "Pull Request", outcome: "Ergebnis",
    findings: "Findings", critical: "Kritisch", high: "Hoch", medium: "Mittel", low: "Niedrig",
    cost: "Kosten", duration: "Dauer",
    outcomes: {
      no_changes: "keine Änderungen", bootstrap: "Basislinie", pass: "bestanden",
      warning: "bestanden mit Warnungen", blocked: "blockiert", error: "Fehler",
    },
    statuses: { completed: "abgeschlossen", failed: "fehlgeschlagen", incomplete: "unvollständig" },
    openGate: "Gate öffnen", openScan: "Scan öffnen",
    reason: "Sie erhalten diese E-Mail, weil Sie die Ereignisse dieses Repositorys abonniert haben.",
    gateBlocked: {
      subject: (repository) => `Okami Sentinel: Gate hat ${repository} blockiert`,
      heading: "Das Gate hat die Änderung blockiert",
      body: "Die Richtlinie des Repositorys hat diese Änderung blockiert. Öffnen Sie das Gate im Sentinel, um Entscheidung und Findings zu sehen.",
    },
    gateError: {
      subject: (repository) => `Okami Sentinel: Gate-Fehler in ${repository}`,
      heading: "Das Gate endete mit einem Fehler",
      body: "Das Gate konnte die Auswertung nicht abschließen; es fällt daher geschlossen aus und die Änderung bleibt ohne Entscheidung. Öffnen Sie das Gate im Sentinel, um den Grund zu sehen.",
    },
    gatePassed: {
      subject: (repository) => `Okami Sentinel: Gate in ${repository} bestanden`,
      heading: "Das Gate hat die Änderung freigegeben",
      body: "Die Richtlinie des Repositorys fand keinen Grund, diese Änderung zu blockieren.",
    },
    gateWarning: {
      subject: (repository) => `Okami Sentinel: Gate in ${repository} mit Warnungen bestanden`,
      heading: "Das Gate hat mit Warnungen freigegeben",
      body: "Die Änderung ging durch, doch die Richtlinie hat Warnungen erfasst. Öffnen Sie das Gate im Sentinel, um sie zu sehen.",
    },
    scanFailed: {
      subject: (repository) => `Okami Sentinel: Scan in ${repository} fehlgeschlagen`,
      heading: "Der Scan wurde nicht abgeschlossen",
      body: "Der Scan endete ohne vollständiges Ergebnis. Öffnen Sie den Scan im Sentinel, um zu sehen, was passiert ist.",
    },
    scanCompleted: {
      subject: (repository) => `Okami Sentinel: Scan in ${repository} abgeschlossen`,
      heading: "Der Scan ist fertig",
      body: "Der Scan ist abgeschlossen und sein Ergebnis ist im Sentinel indexiert.",
    },
  },
  fr: {
    repository: "Dépôt", scan: "Scan", branch: "Branche", pullRequest: "Pull request", outcome: "Résultat",
    findings: "Findings", critical: "Critiques", high: "Élevés", medium: "Moyens", low: "Faibles",
    cost: "Coût", duration: "Durée",
    outcomes: {
      no_changes: "aucun changement", bootstrap: "référence", pass: "validé",
      warning: "validé avec avertissements", blocked: "bloqué", error: "erreur",
    },
    statuses: { completed: "terminé", failed: "échoué", incomplete: "incomplet" },
    openGate: "Ouvrir le gate", openScan: "Ouvrir le scan",
    reason: "Vous recevez cet e-mail parce que vous êtes abonné aux événements de ce dépôt.",
    gateBlocked: {
      subject: (repository) => `Okami Sentinel : gate bloqué sur ${repository}`,
      heading: "Le gate a bloqué le changement",
      body: "La politique du dépôt a bloqué ce changement. Ouvrez le gate dans le Sentinel pour voir la décision et les findings.",
    },
    gateError: {
      subject: (repository) => `Okami Sentinel : erreur du gate sur ${repository}`,
      heading: "Le gate s'est terminé en erreur",
      body: "Le gate n'a pas pu terminer son évaluation ; il échoue donc fermé et le changement reste sans décision. Ouvrez le gate dans le Sentinel pour en voir la raison.",
    },
    gatePassed: {
      subject: (repository) => `Okami Sentinel : gate validé sur ${repository}`,
      heading: "Le gate a validé le changement",
      body: "La politique du dépôt n'a trouvé aucune raison de bloquer ce changement.",
    },
    gateWarning: {
      subject: (repository) => `Okami Sentinel : gate validé avec avertissements sur ${repository}`,
      heading: "Le gate a validé avec des avertissements",
      body: "Le changement est passé, mais la politique a enregistré des avertissements. Ouvrez le gate dans le Sentinel pour les voir.",
    },
    scanFailed: {
      subject: (repository) => `Okami Sentinel : le scan a échoué sur ${repository}`,
      heading: "Le scan ne s'est pas terminé",
      body: "Le scan s'est arrêté sans résultat complet. Ouvrez le scan dans le Sentinel pour voir ce qui s'est passé.",
    },
    scanCompleted: {
      subject: (repository) => `Okami Sentinel : scan terminé sur ${repository}`,
      heading: "Le scan est terminé",
      body: "Le scan est terminé et son résultat est indexé dans le Sentinel.",
    },
  },
});

/**
 * The fact table every repository message shares: what ran, on what, how it
 * came out, how many findings by severity, what it cost and how long it took.
 * Severity is omitted entirely when there was no scan, because four zeros read
 * like a clean result rather than like an absent one.
 */
function severityFacts(
  severity: SeverityCounts | null,
  copy: RepositoryCopy,
): Array<{ label: string; value: string }> {
  if (severity === null) return [];
  return [
    { label: copy.findings, value: String(severity.total) },
    { label: copy.critical, value: String(severity.critical) },
    { label: copy.high, value: String(severity.high) },
    { label: copy.medium, value: String(severity.medium) },
    { label: copy.low, value: String(severity.low) },
  ];
}

/**
 * The same four counts as chips. The block repeats the labels `severityFacts`
 * used, which is how the shell knows which four rows of the key/value panel the
 * chips already say — and therefore which four to leave out of it.
 */
/**
 * The outcomes the status pill already spells out. The fact row is kept for the
 * rest — passed *with warnings*, a baseline, an empty change set, a scan that
 * stopped half-way — because there the word says something the pill does not.
 */
const PILLED_GATE_OUTCOMES: ReadonlySet<GateOutcome> = new Set<GateOutcome>(["blocked", "error", "pass"]);
const PILLED_SCAN_STATUSES: ReadonlySet<ScanEmailData["status"]> =
  new Set<ScanEmailData["status"]>(["completed", "failed"]);

function severityChips(severity: SeverityCounts | null, copy: RepositoryCopy): EmailSeverityBlock | null {
  if (severity === null) return null;
  return {
    counts: {
      critical: severity.critical, high: severity.high,
      medium: severity.medium, low: severity.low,
    },
    labels: {
      critical: copy.critical, high: copy.high,
      medium: copy.medium, low: copy.low,
    },
  };
}

function costAndDurationFacts(
  data: { costUsd: number | null; durationMs: number | null },
  copy: RepositoryCopy,
): Array<{ label: string; value: string }> {
  return [
    ...(data.costUsd === null ? [] : [{ label: copy.cost, value: formatUsd(data.costUsd) }]),
    ...(data.durationMs === null
      ? []
      : [{ label: copy.duration, value: formatDurationShort(data.durationMs) }]),
  ];
}

/**
 * The repository, its branch and its pull request are what the reader scans
 * for first, so they live in the target block — the name large, the ref and
 * the PR as tags — and never again in the fact panel below it.
 */
function gateTarget(data: GateEmailData, copy: RepositoryCopy): EmailTarget {
  return {
    label: copy.repository,
    name: data.repository,
    chips: [
      { label: copy.branch, value: data.branch, kind: "accent" },
      ...(data.pullRequest === null
        ? []
        : [{ label: copy.pullRequest, value: `#${data.pullRequest}`, kind: "neutral" as const }]),
    ],
  };
}

function gateBody(data: GateEmailData, copy: RepositoryCopy, kind: RepositoryKindCopy): EmailTemplateBody {
  return {
    subject: kind.subject(data.repository),
    heading: kind.heading,
    paragraphs: [kind.body],
    target: gateTarget(data, copy),
    facts: [
      ...(PILLED_GATE_OUTCOMES.has(data.outcome)
        ? []
        : [{ label: copy.outcome, value: copy.outcomes[data.outcome] }]),
      ...severityFacts(data.severity, copy),
      ...costAndDurationFacts(data, copy),
    ],
    severity: severityChips(data.severity, copy),
    action: { label: copy.openGate, path: `/guardrails/${data.gateId}` },
    reason: copy.reason,
  };
}

function scanBody(data: ScanEmailData, copy: RepositoryCopy, kind: RepositoryKindCopy): EmailTemplateBody {
  return {
    subject: kind.subject(data.repository ?? data.scanId),
    heading: kind.heading,
    paragraphs: [kind.body],
    target: {
      label: data.repository === null ? copy.scan : copy.repository,
      name: data.repository ?? data.scanId,
      chips: data.branch === null ? [] : [{ label: copy.branch, value: data.branch, kind: "accent" }],
    },
    facts: [
      ...(PILLED_SCAN_STATUSES.has(data.status)
        ? []
        : [{ label: copy.outcome, value: copy.statuses[data.status] }]),
      ...severityFacts(data.severity, copy),
      ...costAndDurationFacts(data, copy),
    ],
    severity: severityChips(data.severity, copy),
    action: { label: copy.openScan, path: `/scans/${data.scanId}` },
    reason: copy.reason,
  };
}

const gateBlocked = defineTemplate<"gate.blocked", RepositoryCopy>({
  group: "repository",
  status: "blocked",
  section: "guardrails",
  copy: REPOSITORY_COPY,
  build: (data, copy) => gateBody(data, copy, copy.gateBlocked),
});

const gateError = defineTemplate<"gate.error", RepositoryCopy>({
  group: "repository",
  status: "error",
  section: "guardrails",
  copy: REPOSITORY_COPY,
  build: (data, copy) => gateBody(data, copy, copy.gateError),
});

/**
 * One subscription covers "passed" and "passed with warnings" — the design puts
 * the warning inside `gate.passed` — so the template, not the subscription,
 * decides which of the two the reader is told about.
 */
const gatePassed = defineTemplate<"gate.passed", RepositoryCopy>({
  group: "repository",
  status: "passed",
  section: "guardrails",
  copy: REPOSITORY_COPY,
  build: (data, copy) => data.outcome === "warning"
    ? { ...gateBody(data, copy, copy.gateWarning), status: "warned" }
    : gateBody(data, copy, copy.gatePassed),
});

const scanFailed = defineTemplate<"scan.failed", RepositoryCopy>({
  group: "repository",
  status: "scan_failed",
  section: "runs",
  copy: REPOSITORY_COPY,
  build: (data, copy) => scanBody(data, copy, copy.scanFailed),
});

const scanCompleted = defineTemplate<"scan.completed", RepositoryCopy>({
  group: "repository",
  status: "completed",
  section: "runs",
  copy: REPOSITORY_COPY,
  build: (data, copy) => scanBody(data, copy, copy.scanCompleted),
});

// --------------------------------------------------------------------------
// Operational events: administrators only, one alert per condition per six
// hours, and one message when the condition ends.
// --------------------------------------------------------------------------

/** Where an administrator goes to act on each alert. */
const ENGINE_SETTINGS_PATH = "/settings/connections";
const CONNECTIONS_PATH = "/settings/connections";
const MONITOR_PATH = "/github";

interface OpsKindCopy {
  subject: string;
  heading: string;
  body: string;
  action: string;
}

interface OpsCopy {
  since: string;
  at: string;
  endedAt: string;
  outageDuration: string;
  engines: string;
  connection: string;
  status: string;
  statuses: Readonly<Record<ConnectionStatus, string>>;
  repository: string;
  branch: string;
  gate: string;
  reasonLabel: string;
  day: string;
  reserved: string;
  ceiling: string;
  share: string;
  /** Why this message arrived, and where to turn it off. */
  reason: string;
  engineUnavailable: OpsKindCopy;
  engineRecovered: OpsKindCopy;
  connectionAttention: OpsKindCopy;
  connectionRecovered: OpsKindCopy;
  dailyCostWarning: OpsKindCopy;
  dailyCostReached: OpsKindCopy;
  publishFailed: OpsKindCopy;
  publishRecovered: OpsKindCopy;
}

const OPS_COPY: Readonly<Record<UserLocale, OpsCopy>> = Object.freeze({
  "pt-BR": {
    since: "Desde", at: "Verificado em", endedAt: "Normalizado em", outageDuration: "Duração",
    engines: "Motores", connection: "Conexão", status: "Status",
    statuses: {
      draft: "rascunho", "authentication-required": "autenticação necessária", testing: "em teste",
      ready: "pronta", degraded: "degradada", expired: "expirada", unavailable: "indisponível",
    },
    repository: "Repositório", branch: "Branch", gate: "Gate", reasonLabel: "Motivo",
    day: "Dia (UTC)", reserved: "Reservado", ceiling: "Teto diário", share: "Percentual",
    reason: "Você recebe este e-mail porque é administrador e assina os alertas operacionais.",
    engineUnavailable: {
      subject: "Okami Sentinel: motor indisponível",
      heading: "O motor está indisponível",
      body: "Nenhum motor de scan está disponível há mais de cinco minutos. Novos scans e gates não vão iniciar até que isso se resolva.",
      action: "Abrir as conexões",
    },
    engineRecovered: {
      subject: "Okami Sentinel: motor disponível novamente",
      heading: "O motor voltou",
      body: "Ao menos um motor de scan está disponível outra vez. Novos scans e gates podem iniciar.",
      action: "Abrir as conexões",
    },
    connectionAttention: {
      subject: "Okami Sentinel: conexão precisa de atenção",
      heading: "Uma conexão precisa de atenção",
      body: "Esta conexão de provedor deixou de responder como pronta. Os scans que dependem dela vão falhar até que ela seja restabelecida.",
      action: "Abrir as conexões",
    },
    connectionRecovered: {
      subject: "Okami Sentinel: conexão normalizada",
      heading: "A conexão voltou a ficar pronta",
      body: "Esta conexão de provedor está pronta novamente.",
      action: "Abrir as conexões",
    },
    dailyCostWarning: {
      subject: "Okami Sentinel: 80% do teto diário de custo",
      heading: "O teto diário chegou a 80%",
      body: "As reservas automáticas de scan deste repositório já usaram 80% do teto do dia.",
      action: "Abrir o monitoramento do GitHub",
    },
    dailyCostReached: {
      subject: "Okami Sentinel: teto diário de custo atingido",
      heading: "O teto diário foi atingido",
      body: "As reservas automáticas de scan deste repositório atingiram o teto do dia. Novos scans automáticos ficam na fila até o próximo dia UTC.",
      action: "Abrir o monitoramento do GitHub",
    },
    publishFailed: {
      subject: "Okami Sentinel: falha ao publicar o check no GitHub",
      heading: "A publicação no GitHub falhou",
      body: "A decisão do gate está gravada no Sentinel, mas o check não chegou ao GitHub. O pull request não mostra o resultado até que a publicação seja repetida.",
      action: "Abrir o gate",
    },
    publishRecovered: {
      subject: "Okami Sentinel: check publicado no GitHub",
      heading: "A publicação no GitHub foi concluída",
      body: "O check deste gate chegou ao GitHub.",
      action: "Abrir o gate",
    },
  },
  en: {
    since: "Since", at: "Checked at", endedAt: "Recovered at", outageDuration: "Duration",
    engines: "Engines", connection: "Connection", status: "Status",
    statuses: {
      draft: "draft", "authentication-required": "authentication required", testing: "testing",
      ready: "ready", degraded: "degraded", expired: "expired", unavailable: "unavailable",
    },
    repository: "Repository", branch: "Branch", gate: "Gate", reasonLabel: "Reason",
    day: "Day (UTC)", reserved: "Reserved", ceiling: "Daily ceiling", share: "Share",
    reason: "You receive this e-mail because you are an administrator and subscribe to the operational alerts.",
    engineUnavailable: {
      subject: "Okami Sentinel: engine unavailable",
      heading: "The engine is unavailable",
      body: "No scan engine has been available for more than five minutes. New scans and gates will not start until this is resolved.",
      action: "Open the connections",
    },
    engineRecovered: {
      subject: "Okami Sentinel: engine available again",
      heading: "The engine is back",
      body: "At least one scan engine is available again. New scans and gates can start.",
      action: "Open the connections",
    },
    connectionAttention: {
      subject: "Okami Sentinel: a connection needs attention",
      heading: "A connection needs attention",
      body: "This provider connection stopped answering as ready. Scans that depend on it will fail until it is restored.",
      action: "Open the connections",
    },
    connectionRecovered: {
      subject: "Okami Sentinel: connection restored",
      heading: "The connection is ready again",
      body: "This provider connection is ready again.",
      action: "Open the connections",
    },
    dailyCostWarning: {
      subject: "Okami Sentinel: 80% of the daily cost ceiling",
      heading: "The daily ceiling reached 80%",
      body: "This repository's automatic scan reservations have used 80% of today's ceiling.",
      action: "Open the GitHub monitor",
    },
    dailyCostReached: {
      subject: "Okami Sentinel: daily cost ceiling reached",
      heading: "The daily ceiling has been reached",
      body: "This repository's automatic scan reservations reached today's ceiling. New automatic scans stay queued until the next UTC day.",
      action: "Open the GitHub monitor",
    },
    publishFailed: {
      subject: "Okami Sentinel: could not publish the GitHub check",
      heading: "Publishing to GitHub failed",
      body: "The gate decision is stored in the Sentinel, but the check never reached GitHub. The pull request shows no result until publishing is retried.",
      action: "Open the gate",
    },
    publishRecovered: {
      subject: "Okami Sentinel: GitHub check published",
      heading: "Publishing to GitHub succeeded",
      body: "This gate's check reached GitHub.",
      action: "Open the gate",
    },
  },
  es: {
    since: "Desde", at: "Verificado el", endedAt: "Normalizado el", outageDuration: "Duración",
    engines: "Motores", connection: "Conexión", status: "Estado",
    statuses: {
      draft: "borrador", "authentication-required": "requiere autenticación", testing: "en prueba",
      ready: "lista", degraded: "degradada", expired: "expirada", unavailable: "no disponible",
    },
    repository: "Repositorio", branch: "Rama", gate: "Gate", reasonLabel: "Motivo",
    day: "Día (UTC)", reserved: "Reservado", ceiling: "Techo diario", share: "Porcentaje",
    reason: "Recibes este correo porque eres administrador y estás suscrito a las alertas operativas.",
    engineUnavailable: {
      subject: "Okami Sentinel: motor no disponible",
      heading: "El motor no está disponible",
      body: "Ningún motor de scan está disponible desde hace más de cinco minutos. Los nuevos scans y gates no van a iniciar hasta que se resuelva.",
      action: "Abrir las conexiones",
    },
    engineRecovered: {
      subject: "Okami Sentinel: motor disponible otra vez",
      heading: "El motor volvió",
      body: "Al menos un motor de scan está disponible otra vez. Los nuevos scans y gates pueden iniciar.",
      action: "Abrir las conexiones",
    },
    connectionAttention: {
      subject: "Okami Sentinel: una conexión necesita atención",
      heading: "Una conexión necesita atención",
      body: "Esta conexión de proveedor dejó de responder como lista. Los scans que dependen de ella van a fallar hasta que se restablezca.",
      action: "Abrir las conexiones",
    },
    connectionRecovered: {
      subject: "Okami Sentinel: conexión restablecida",
      heading: "La conexión volvió a estar lista",
      body: "Esta conexión de proveedor está lista otra vez.",
      action: "Abrir las conexiones",
    },
    dailyCostWarning: {
      subject: "Okami Sentinel: 80% del techo diario de costo",
      heading: "El techo diario llegó al 80%",
      body: "Las reservas automáticas de scan de este repositorio ya usaron el 80% del techo del día.",
      action: "Abrir el monitoreo de GitHub",
    },
    dailyCostReached: {
      subject: "Okami Sentinel: techo diario de costo alcanzado",
      heading: "Se alcanzó el techo diario",
      body: "Las reservas automáticas de scan de este repositorio alcanzaron el techo del día. Los nuevos scans automáticos quedan en la cola hasta el próximo día UTC.",
      action: "Abrir el monitoreo de GitHub",
    },
    publishFailed: {
      subject: "Okami Sentinel: no se pudo publicar el check en GitHub",
      heading: "La publicación en GitHub falló",
      body: "La decisión del gate está guardada en el Sentinel, pero el check no llegó a GitHub. El pull request no muestra el resultado hasta que se reintente la publicación.",
      action: "Abrir el gate",
    },
    publishRecovered: {
      subject: "Okami Sentinel: check publicado en GitHub",
      heading: "La publicación en GitHub se completó",
      body: "El check de este gate llegó a GitHub.",
      action: "Abrir el gate",
    },
  },
  de: {
    since: "Seit", at: "Geprüft am", endedAt: "Behoben am", outageDuration: "Dauer",
    engines: "Engines", connection: "Verbindung", status: "Status",
    statuses: {
      draft: "Entwurf", "authentication-required": "Anmeldung erforderlich", testing: "im Test",
      ready: "bereit", degraded: "eingeschränkt", expired: "abgelaufen", unavailable: "nicht verfügbar",
    },
    repository: "Repository", branch: "Branch", gate: "Gate", reasonLabel: "Grund",
    day: "Tag (UTC)", reserved: "Reserviert", ceiling: "Tagesobergrenze", share: "Anteil",
    reason: "Sie erhalten diese E-Mail, weil Sie Administrator sind und die betrieblichen Warnungen abonniert haben.",
    engineUnavailable: {
      subject: "Okami Sentinel: Engine nicht verfügbar",
      heading: "Die Engine ist nicht verfügbar",
      body: "Seit mehr als fünf Minuten ist keine Scan-Engine verfügbar. Neue Scans und Gates starten nicht, bis das behoben ist.",
      action: "Verbindungen öffnen",
    },
    engineRecovered: {
      subject: "Okami Sentinel: Engine wieder verfügbar",
      heading: "Die Engine ist zurück",
      body: "Mindestens eine Scan-Engine ist wieder verfügbar. Neue Scans und Gates können starten.",
      action: "Verbindungen öffnen",
    },
    connectionAttention: {
      subject: "Okami Sentinel: eine Verbindung braucht Aufmerksamkeit",
      heading: "Eine Verbindung braucht Aufmerksamkeit",
      body: "Diese Anbieterverbindung meldet sich nicht mehr als bereit. Scans, die von ihr abhängen, schlagen fehl, bis sie wiederhergestellt ist.",
      action: "Verbindungen öffnen",
    },
    connectionRecovered: {
      subject: "Okami Sentinel: Verbindung wiederhergestellt",
      heading: "Die Verbindung ist wieder bereit",
      body: "Diese Anbieterverbindung ist wieder bereit.",
      action: "Verbindungen öffnen",
    },
    dailyCostWarning: {
      subject: "Okami Sentinel: 80 % der Tagesobergrenze",
      heading: "Die Tagesobergrenze hat 80 % erreicht",
      body: "Die automatischen Scan-Reservierungen dieses Repositorys haben 80 % der heutigen Obergrenze verbraucht.",
      action: "GitHub-Überwachung öffnen",
    },
    dailyCostReached: {
      subject: "Okami Sentinel: Tagesobergrenze erreicht",
      heading: "Die Tagesobergrenze ist erreicht",
      body: "Die automatischen Scan-Reservierungen dieses Repositorys haben die heutige Obergrenze erreicht. Neue automatische Scans bleiben bis zum nächsten UTC-Tag in der Warteschlange.",
      action: "GitHub-Überwachung öffnen",
    },
    publishFailed: {
      subject: "Okami Sentinel: GitHub-Check konnte nicht veröffentlicht werden",
      heading: "Die Veröffentlichung auf GitHub ist fehlgeschlagen",
      body: "Die Gate-Entscheidung ist im Sentinel gespeichert, der Check hat GitHub aber nicht erreicht. Der Pull Request zeigt kein Ergebnis, bis die Veröffentlichung wiederholt wird.",
      action: "Gate öffnen",
    },
    publishRecovered: {
      subject: "Okami Sentinel: GitHub-Check veröffentlicht",
      heading: "Die Veröffentlichung auf GitHub war erfolgreich",
      body: "Der Check dieses Gates hat GitHub erreicht.",
      action: "Gate öffnen",
    },
  },
  fr: {
    since: "Depuis", at: "Vérifié le", endedAt: "Rétabli le", outageDuration: "Durée",
    engines: "Moteurs", connection: "Connexion", status: "État",
    statuses: {
      draft: "brouillon", "authentication-required": "authentification requise", testing: "en test",
      ready: "prête", degraded: "dégradée", expired: "expirée", unavailable: "indisponible",
    },
    repository: "Dépôt", branch: "Branche", gate: "Gate", reasonLabel: "Raison",
    day: "Jour (UTC)", reserved: "Réservé", ceiling: "Plafond", share: "Part",
    reason: "Vous recevez cet e-mail parce que vous êtes administrateur et abonné aux alertes opérationnelles.",
    engineUnavailable: {
      subject: "Okami Sentinel : moteur indisponible",
      heading: "Le moteur est indisponible",
      body: "Aucun moteur de scan n'est disponible depuis plus de cinq minutes. Les nouveaux scans et gates ne démarreront pas tant que ce n'est pas résolu.",
      action: "Ouvrir les connexions",
    },
    engineRecovered: {
      subject: "Okami Sentinel : moteur de nouveau disponible",
      heading: "Le moteur est revenu",
      body: "Au moins un moteur de scan est de nouveau disponible. Les nouveaux scans et gates peuvent démarrer.",
      action: "Ouvrir les connexions",
    },
    connectionAttention: {
      subject: "Okami Sentinel : une connexion demande votre attention",
      heading: "Une connexion demande votre attention",
      body: "Cette connexion de fournisseur ne répond plus comme prête. Les scans qui en dépendent échoueront tant qu'elle n'est pas rétablie.",
      action: "Ouvrir les connexions",
    },
    connectionRecovered: {
      subject: "Okami Sentinel : connexion rétablie",
      heading: "La connexion est de nouveau prête",
      body: "Cette connexion de fournisseur est de nouveau prête.",
      action: "Ouvrir les connexions",
    },
    dailyCostWarning: {
      subject: "Okami Sentinel : 80 % du plafond de coût journalier",
      heading: "Le plafond journalier atteint 80 %",
      body: "Les réservations automatiques de scan de ce dépôt ont consommé 80 % du plafond du jour.",
      action: "Ouvrir la surveillance GitHub",
    },
    dailyCostReached: {
      subject: "Okami Sentinel : plafond de coût journalier atteint",
      heading: "Le plafond journalier est atteint",
      body: "Les réservations automatiques de scan de ce dépôt ont atteint le plafond du jour. Les nouveaux scans automatiques restent en file jusqu'au prochain jour UTC.",
      action: "Ouvrir la surveillance GitHub",
    },
    publishFailed: {
      subject: "Okami Sentinel : échec de publication du check GitHub",
      heading: "La publication sur GitHub a échoué",
      body: "La décision du gate est enregistrée dans le Sentinel, mais le check n'est pas arrivé sur GitHub. La pull request n'affiche aucun résultat tant que la publication n'est pas relancée.",
      action: "Ouvrir le gate",
    },
    publishRecovered: {
      subject: "Okami Sentinel : check GitHub publié",
      heading: "La publication sur GitHub a réussi",
      body: "Le check de ce gate est arrivé sur GitHub.",
      action: "Ouvrir le gate",
    },
  },
});

/** How long the condition lasted, from the two stamps the alert state keeps. */
function outageFacts(data: OpsResolvedData, copy: OpsCopy): Array<{ label: string; value: string }> {
  return [
    { label: copy.since, value: formatMoment(data.since) },
    { label: copy.endedAt, value: formatMoment(data.at) },
    {
      label: copy.outageDuration,
      value: formatDurationShort(Math.max(0, data.at.getTime() - data.since.getTime())),
    },
  ];
}

const opsEngineUnavailable = defineTemplate<"ops.engine_unavailable", OpsCopy>({
  group: "ops",
  status: "unavailable",
  section: "connections",
  copy: OPS_COPY,
  build: (data, copy) => ({
    subject: copy.engineUnavailable.subject,
    heading: copy.engineUnavailable.heading,
    paragraphs: [copy.engineUnavailable.body],
    facts: [
      { label: copy.since, value: formatMoment(data.since) },
      { label: copy.at, value: formatMoment(data.at) },
      ...(data.engines.length === 0 ? [] : [{ label: copy.engines, value: data.engines.join(", ") }]),
    ],
    severity: null,
    action: { label: copy.engineUnavailable.action, path: ENGINE_SETTINGS_PATH },
    reason: copy.reason,
  }),
});

const opsEngineRecovered = defineTemplate<"ops.engine_unavailable.resolved", OpsCopy>({
  group: "ops",
  status: "resolved",
  section: "connections",
  copy: OPS_COPY,
  build: (data, copy) => ({
    subject: copy.engineRecovered.subject,
    heading: copy.engineRecovered.heading,
    paragraphs: [copy.engineRecovered.body],
    facts: outageFacts(data, copy),
    severity: null,
    action: { label: copy.engineRecovered.action, path: ENGINE_SETTINGS_PATH },
    reason: copy.reason,
  }),
});

const opsConnectionAttention = defineTemplate<"ops.connection_attention", OpsCopy>({
  group: "ops",
  status: "attention",
  section: "connections",
  copy: OPS_COPY,
  build: (data, copy) => ({
    subject: copy.connectionAttention.subject,
    heading: copy.connectionAttention.heading,
    paragraphs: [copy.connectionAttention.body],
    target: {
      label: copy.connection,
      name: data.connectionName,
      chips: [{ label: copy.status, value: copy.statuses[data.status], kind: "neutral" }],
    },
    facts: [
      { label: copy.since, value: formatMoment(data.since) },
      { label: copy.at, value: formatMoment(data.at) },
    ],
    severity: null,
    action: { label: copy.connectionAttention.action, path: CONNECTIONS_PATH },
    reason: copy.reason,
  }),
});

const opsConnectionRecovered = defineTemplate<"ops.connection_attention.resolved", OpsCopy>({
  group: "ops",
  status: "resolved",
  section: "connections",
  copy: OPS_COPY,
  build: (data, copy) => ({
    subject: copy.connectionRecovered.subject,
    heading: copy.connectionRecovered.heading,
    paragraphs: [copy.connectionRecovered.body],
    target: { label: copy.connection, name: data.connectionName, chips: [] },
    facts: outageFacts(data, copy),
    severity: null,
    action: { label: copy.connectionRecovered.action, path: CONNECTIONS_PATH },
    reason: copy.reason,
  }),
});

const opsDailyCost = defineTemplate<"ops.daily_cost", OpsCopy>({
  group: "ops",
  status: "ceiling",
  section: "github",
  copy: OPS_COPY,
  build: (data, copy) => {
    const kind = data.percent >= 100 ? copy.dailyCostReached : copy.dailyCostWarning;
    return {
      subject: kind.subject,
      heading: kind.heading,
      paragraphs: [kind.body],
      target: { label: copy.repository, name: data.repository, chips: [] },
      facts: [
        { label: copy.day, value: data.day },
        { label: copy.reserved, value: formatUsd(data.reservedUsd) },
        { label: copy.ceiling, value: formatUsd(data.ceilingUsd) },
        { label: copy.share, value: `${data.percent}%` },
      ],
      severity: null,
      action: { label: kind.action, path: MONITOR_PATH },
      reason: copy.reason,
      status: data.percent >= 100 ? "ceiling_reached" : "ceiling",
    };
  },
});

const opsPublishFailed = defineTemplate<"ops.github_publish_failed", OpsCopy>({
  group: "ops",
  status: "publish_failed",
  section: "guardrails",
  copy: OPS_COPY,
  build: (data, copy) => ({
    subject: copy.publishFailed.subject,
    heading: copy.publishFailed.heading,
    paragraphs: [copy.publishFailed.body],
    target: {
      label: copy.repository,
      name: data.repository,
      chips: [{ label: copy.branch, value: data.branch, kind: "accent" }],
    },
    facts: [
      { label: copy.gate, value: data.gateId },
      { label: copy.reasonLabel, value: data.reason },
      { label: copy.at, value: formatMoment(data.at) },
    ],
    severity: null,
    action: { label: copy.publishFailed.action, path: `/guardrails/${data.gateId}` },
    reason: copy.reason,
  }),
});

const opsPublishRecovered = defineTemplate<"ops.github_publish_failed.resolved", OpsCopy>({
  group: "ops",
  status: "resolved",
  section: "guardrails",
  copy: OPS_COPY,
  build: (data, copy) => ({
    subject: copy.publishRecovered.subject,
    heading: copy.publishRecovered.heading,
    paragraphs: [copy.publishRecovered.body],
    target: { label: copy.repository, name: data.repository, chips: [] },
    facts: [
      { label: copy.gate, value: data.gateId },
      ...outageFacts(data, copy),
    ],
    severity: null,
    action: { label: copy.publishRecovered.action, path: `/guardrails/${data.gateId}` },
    reason: copy.reason,
  }),
});

/**
 * The registry. The mapped type makes a missing entry — or an entry for a kind
 * that is not in the data map — a compile error, so a new kind cannot reach the
 * outbox without a body in all five languages.
 */
const TEMPLATES: { [K in EmailMessageKind]: TemplateDefinition<K> } = {
  "account.test": accountTest,
  "account.invite": accountInvite,
  "account.reset": accountReset,
  "account.new_login": accountNewLogin,
  "account.locked": accountLocked,
  "account.password_changed": accountPasswordChanged,
  "gate.blocked": gateBlocked,
  "gate.error": gateError,
  "gate.passed": gatePassed,
  "scan.failed": scanFailed,
  "scan.completed": scanCompleted,
  "ops.engine_unavailable": opsEngineUnavailable,
  "ops.engine_unavailable.resolved": opsEngineRecovered,
  "ops.connection_attention": opsConnectionAttention,
  "ops.connection_attention.resolved": opsConnectionRecovered,
  "ops.daily_cost": opsDailyCost,
  "ops.github_publish_failed": opsPublishFailed,
  "ops.github_publish_failed.resolved": opsPublishRecovered,
};

export const EMAIL_MESSAGE_KINDS = Object.keys(TEMPLATES) as EmailMessageKind[];

export function emailMessageGroup(kind: EmailMessageKind): EmailMessageGroup {
  return TEMPLATES[kind].group;
}

/** The status a kind shows by default; a body may override it from its data. */
export function emailMessageStatus(kind: EmailMessageKind): EmailStatusKey {
  return TEMPLATES[kind].status;
}

/** The app module a kind's eyebrow names. */
export function emailMessageSection(kind: EmailMessageKind): EmailSectionKey {
  return TEMPLATES[kind].section;
}

// --------------------------------------------------------------------------
// The shell's palette. The message is dark-native — the interface's dark theme
// is the design, in every client, with no light/dark switching — so every
// colour below is the dark theme's token resolved to sRGB hex, once, here.
// Nothing downstream computes a colour.
// --------------------------------------------------------------------------

const PAGE = "#060609";           // --color-base-200, dark
const CARD = "#0b0b12";           // --color-base-100, dark
const PANEL = "#11111b";          // --color-neutral, dark
const LINE = "#1f1f2e";           // --border, dark
const LINE_SOFT = "#262637";
// Near-white and near-black, never pure: a client's forced inversion keys on
// #fff/#000, and these stay legible whether or not it fires.
const TX = "#f4f4f8";             // --color-base-content, dark
const BODY_TX = "#c6c7d2";
const MUTED = "#9293a4";          // --muted-foreground, dark
const FAINT = "#71718a";
const CYAN = "#00dfe8";           // primary — oklch(82% 0.14 200)
const MAGENTA = "#ff39d1";        // secondary — oklch(70% 0.27 340)
const ORANGE = "#ff7527";         // accent — oklch(72% 0.19 45)
const GREEN = "#5fd37f";          // success — oklch(78% 0.16 150)
const YELLOW = "#f3ba25";         // warning — oklch(82% 0.16 85)
const RED = "#f94144";            // error — oklch(65% 0.22 25)
const BTN_INK = "#060609";

const SANS = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const MONO = "ui-monospace,SFMono-Regular,Menlo,Consolas,'Courier New',monospace";

/**
 * One colour per status, in one table: the status word, the header indicator
 * and the signature dot all read from here, so a kind cannot be one colour in
 * the hero and another in the header.
 */
const STATUS_ACCENTS: Readonly<Record<EmailStatusKey, string>> = Object.freeze({
  test: CYAN, invite: CYAN, reset: CYAN,
  new_login: YELLOW, locked: YELLOW, password_changed: YELLOW,
  blocked: MAGENTA, error: RED, passed: GREEN, warned: YELLOW,
  scan_failed: RED, completed: GREEN,
  unavailable: ORANGE, attention: ORANGE, ceiling: YELLOW,
  ceiling_reached: ORANGE, publish_failed: RED, resolved: GREEN,
});

/** The four severity counts, in the dark theme's own severity colours. */
type SeverityLevel = "critical" | "high" | "medium" | "low";
const SEVERITY_LEVELS: readonly SeverityLevel[] = ["critical", "high", "medium", "low"];
const SEVERITY_BARS: Readonly<Record<SeverityLevel, string>> = Object.freeze({
  critical: MAGENTA, high: "#b52b98", medium: YELLOW, low: CYAN,
});

/**
 * The status word is the hero, and "FEHLGESCHLAGEN" is not "ERRO": the size
 * and tracking come from the label's length so the longest localized word
 * still fits a 375-pixel screen, with the media query shrinking each bucket
 * once more below 480.
 */
function statusWordBucket(label: string): { size: number; spacing: string; cls: string } {
  if (label.length <= 10) return { size: 31, spacing: ".12em", cls: "sw-l" };
  if (label.length <= 15) return { size: 25, spacing: ".10em", cls: "sw-m" };
  if (label.length <= 20) return { size: 20, spacing: ".08em", cls: "sw-s" };
  return { size: 17, spacing: ".05em", cls: "sw-x" };
}

/**
 * The two messages whose reader cannot pass a login yet: the invitee has no
 * password and the reset reader is locked out of theirs. A "my account" link
 * would only open a door they cannot walk through, so their footer keeps the
 * reason and drops the link.
 */
const KINDS_WITHOUT_FOOTER_LINK: ReadonlySet<EmailMessageKind> = new Set([
  "account.invite", "account.reset",
]);

export interface RenderEmailInput<K extends EmailMessageKind> {
  kind: K;
  data: EmailMessageDataMap[K];
  locale: UserLocale;
  /** `null` in local mode: the message then names no link and shows no image. */
  origin: string | null;
  /**
   * The moment the signature strip prints. It defaults to the wall clock at
   * render time — the honest answer — and exists as an input so a test can
   * pin it.
   */
  now?: Date;
}

/** The mark, small enough for an inbox; served from the same origin as the app. */
const LOGO_PATH = "/brand/email-mark.png";
const LOGO_WIDTH = 30;
const LOGO_HEIGHT = 37;
/** Pre-dimmed on the card colour and shipped at 2x, so it needs no CSS opacity. */
const WATERMARK_PATH = "/brand/email-wolf-watermark.png";
const WATERMARK_WIDTH = 80;
const WATERMARK_HEIGHT = 99;

/**
 * The head stylesheet. It is the only stylesheet, it is never required for the
 * message to read correctly — every element also carries its inline style and
 * every dark surface its `bgcolor` — and it carries only what no inline style
 * can express: the phone-width tweaks. There is no light scheme to switch to;
 * the design is dark everywhere by construction.
 */
const HEAD_STYLE = [
  `body{margin:0;padding:0;width:100%!important;-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%}`,
  `table{border-collapse:collapse}`,
  `img{border:0;outline:none;text-decoration:none;-ms-interpolation-mode:bicubic}`,
  `@media only screen and (max-width:480px){`,
  `.pad{padding-left:16px!important;padding-right:16px!important}`,
  `.hdr{padding-left:16px!important;padding-right:16px!important}`,
  `.foot{padding-left:16px!important;padding-right:16px!important}`,
  `.sigrow{padding-left:16px!important;padding-right:16px!important}`,
  `.sw-l{font-size:25px!important}`,
  `.sw-m{font-size:20px!important}`,
  `.sw-s{font-size:16px!important}`,
  `.sw-x{font-size:14px!important}`,
  `.t-name{font-size:16px!important;line-height:21px!important}`,
  `.chip-v{font-size:16px!important}`,
  `.hs{display:none!important}`,
  `}`,
].join("");

/**
 * The shell — Direction B, the console the interface already is at night.
 * Table layout, inline styles, no external stylesheet and no script, because a
 * mail client will strip or ignore all three; a plain-text twin is always
 * produced, because some clients only show that one.
 */
export function renderEmail<K extends EmailMessageKind>(input: RenderEmailInput<K>): RenderedEmail {
  const shell = SHELL[input.locale];
  const definition = TEMPLATES[input.kind];
  const body = definition.build(input.data, input.locale);
  const group = definition.group;
  const status = body.status ?? definition.status;
  const accent = STATUS_ACCENTS[status];
  const statusLabel = shell.statuses[status];
  const groupLabel = shell.groups[group];
  const eyebrow = `${SECTION_CODES[definition.section]} / ${shell.sections[definition.section].toLocaleUpperCase(input.locale)}`;
  const readAt = formatMoment(input.now ?? new Date());
  const footerPath = group === "account" ? ACCOUNT_PATH : NOTIFICATIONS_PATH;
  const footerLabel = group === "account" ? shell.accountAction : shell.notificationsAction;
  // A relative link is dead in a mail client, so without a public origin the
  // message carries no link and the footer says why instead of pretending.
  const url = (path: string): string | null => (input.origin === null ? null : `${input.origin}${path}`);
  const actionUrl = body.action === null ? null : url(body.action.path);
  const linklessFooter = KINDS_WITHOUT_FOOTER_LINK.has(input.kind);
  const footerUrl = url(footerPath);
  const logoUrl = url(LOGO_PATH);
  const watermarkUrl = url(WATERMARK_PATH);
  const target = body.target ?? null;

  const text = [
    `${shell.brand} · ${groupLabel}`,
    `[${statusLabel}]`,
    "",
    body.heading,
    "",
    ...body.paragraphs.flatMap((paragraph) => [paragraph, ""]),
    ...(target === null
      ? []
      : [`${target.label}: ${target.name}`, ...target.chips.map((chip) => `${chip.label}: ${chip.value}`)]),
    ...body.facts.map((fact) => `${fact.label}: ${fact.value}`),
    ...(body.action !== null && actionUrl !== null ? ["", `${body.action.label}: ${actionUrl}`] : []),
    "",
    "--",
    body.reason,
    // Without an origin the missing links still get their one-line why; a
    // linkless footer with an origin simply says nothing where the link was.
    ...(footerUrl === null ? [shell.noLinks] : linklessFooter ? [] : [`${footerLabel}: ${footerUrl}`]),
    shell.signature,
  ].join("\n");

  // The corner ticks of `.bench-corners`: the interface's panels carry a
  // primary-coloured tick on two corners, and so does the card.
  const tickTop = [
    `<tr><td><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>`,
    `<td width="9" height="9" style="border-top:2px solid ${CYAN};border-left:2px solid ${CYAN};font-size:1px;line-height:1px">&nbsp;</td>`,
    `<td style="font-size:1px;line-height:1px">&nbsp;</td>`,
    `</tr></table></td></tr>`,
  ].join("");
  const tickBottom = [
    `<tr><td><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>`,
    `<td style="font-size:1px;line-height:1px">&nbsp;</td>`,
    `<td width="9" height="9" style="border-bottom:2px solid ${CYAN};border-right:2px solid ${CYAN};font-size:1px;line-height:1px">&nbsp;</td>`,
    `</tr></table></td></tr>`,
  ].join("");

  // The header. Without an origin there is no image to fetch, so the wordmark
  // carries the brand alone rather than showing a broken frame. On the right,
  // the indicator says only what this message itself established — its own
  // status — never the state of an engine it did not measure.
  const logoCell = logoUrl === null ? "" : [
    `<td style="padding:0 11px 0 0;vertical-align:middle">`,
    `<img src="${escapeHtml(logoUrl)}" width="${LOGO_WIDTH}" height="${LOGO_HEIGHT}"`,
    ` alt="${escapeHtml(shell.brand)}"`,
    ` style="display:block;width:${LOGO_WIDTH}px;height:${LOGO_HEIGHT}px;border:0;color:${TX};font-family:${SANS};font-size:10px">`,
    `</td>`,
  ].join("");

  const header = [
    `<tr><td class="hdr" style="padding:14px 22px;border-bottom:1px solid ${LINE}">`,
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>`,
    `<td align="left" style="vertical-align:middle">`,
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>`,
    logoCell,
    `<td style="vertical-align:middle;font-family:${SANS};font-size:13px;line-height:16px;font-weight:700;letter-spacing:.14em;color:${TX}">OKAMI`,
    `<span style="font-family:${MONO};font-size:9px;font-weight:400;letter-spacing:.1em;color:${MUTED}">&nbsp;/ SENTINEL</span>`,
    `</td></tr></table>`,
    `</td>`,
    `<td class="hs ind" align="right" style="vertical-align:middle;font-family:${MONO};font-size:9px;line-height:12px;letter-spacing:.16em;text-transform:uppercase;color:${accent}">&#9679;&nbsp; ${escapeHtml(statusLabel)}</td>`,
    `</tr></table>`,
    `</td></tr>`,
  ].join("");

  // The hero: the module's eyebrow, the status word in the status colour, and
  // the wolf — pre-dimmed into the asset itself, so Outlook needs no opacity.
  const bucket = statusWordBucket(statusLabel);
  const watermarkCell = watermarkUrl === null ? "" : [
    `<td width="${WATERMARK_WIDTH + 12}" align="right" class="hs" style="vertical-align:top;padding-left:12px">`,
    `<img src="${escapeHtml(watermarkUrl)}" width="${WATERMARK_WIDTH}" height="${WATERMARK_HEIGHT}" alt=""`,
    ` style="display:block;width:${WATERMARK_WIDTH}px;height:${WATERMARK_HEIGHT}px;border:0">`,
    `</td>`,
  ].join("");

  const targetHtml = target === null ? "" : [
    `<div style="padding-top:20px">`,
    `<div style="font-family:${MONO};font-size:8.5px;line-height:11px;letter-spacing:.16em;text-transform:uppercase;color:${FAINT}">${escapeHtml(target.label)}</div>`,
    `<div class="t-name" style="padding-top:5px;font-family:${MONO};font-size:20px;line-height:26px;font-weight:700;color:${TX};word-break:break-word">${escapeHtml(target.name)}</div>`,
    target.chips.length === 0 ? "" : `<div style="padding-top:3px">${target.chips.map((chip) => {
      const accentChip = chip.kind === "accent";
      const border = accentChip ? "#156d74" : LINE_SOFT;
      const chipBg = accentChip ? "#07262a" : PANEL;
      const ink = accentChip ? "#4fe3ea" : MUTED;
      return `<span class="chip" style="display:inline-block;margin:7px 7px 0 0;padding:4px 9px;border:1px solid ${border};background:${chipBg};font-family:${MONO};font-size:11px;line-height:15px;color:${ink};word-break:break-all">${escapeHtml(chip.value)}</span>`;
    }).join("")}</div>`,
    `</div>`,
  ].join("");

  const hero = [
    `<tr><td class="pad" style="padding:24px 22px 0">`,
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>`,
    `<td style="vertical-align:top">`,
    `<div class="eyebrow" style="font-family:${MONO};font-size:9px;line-height:12px;letter-spacing:.18em;text-transform:uppercase;color:${MUTED}">${escapeHtml(eyebrow)}</div>`,
    `<div class="sw ${bucket.cls}" style="padding-top:10px;font-family:${MONO};font-size:${bucket.size}px;line-height:1.15;font-weight:800;letter-spacing:${bucket.spacing};color:${accent}">${escapeHtml(statusLabel)}</div>`,
    targetHtml,
    // The heading lives beside the watermark, so a message without a target
    // block does not inherit the watermark's height as dead space.
    `<h1 class="h1" style="margin:18px 0 0;font-family:${SANS};font-size:17px;line-height:1.4;font-weight:700;letter-spacing:-.01em;color:${TX}">${escapeHtml(body.heading)}</h1>`,
    `</td>`,
    watermarkCell,
    `</tr></table>`,
    `</td></tr>`,
  ].join("");

  const paragraphs = body.paragraphs.map((paragraph, index) =>
    `<p class="para" style="margin:${index === 0 ? 16 : 10}px 0 0;`
    + `font-family:${SANS};font-size:13.5px;line-height:1.65;color:${BODY_TX}">${escapeHtml(paragraph)}</p>`).join("");

  // Four counts as four instrument cells. A zero is dimmed rather than
  // dropped: the reader is being told there is nothing at that level, which is
  // itself the news.
  const severityHtml = body.severity === null ? "" : [
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:22px 0 0"><tr>`,
    ...SEVERITY_LEVELS.map((level, index) => {
      const count = body.severity!.counts[level];
      const label = body.severity!.labels[level];
      const zero = count === 0;
      const bar = zero ? LINE_SOFT : SEVERITY_BARS[level];
      return [
        `<td width="25%" style="width:25%;padding:0 ${index === SEVERITY_LEVELS.length - 1 ? 0 : 6}px 0 0;vertical-align:top">`,
        `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="panel" bgcolor="${PANEL}" style="background:${PANEL};border:1px solid ${LINE}">`,
        `<tr><td class="${zero ? "bar-off" : `bar-${level}`}" bgcolor="${bar}" style="background:${bar};height:2px;line-height:2px;font-size:1px">&nbsp;</td></tr>`,
        `<tr><td style="padding:8px 10px 10px">`,
        `<div class="${zero ? "chip-off" : "chip-l"}" style="font-family:${MONO};font-size:8px;line-height:10px;letter-spacing:.12em;text-transform:uppercase;color:${zero ? FAINT : MUTED}">${escapeHtml(label)}</div>`,
        `<div class="${zero ? "chip-off" : "chip-v"}" style="padding-top:4px;font-family:${MONO};font-size:21px;line-height:23px;font-weight:700;color:${zero ? FAINT : TX}">${escapeHtml(String(count))}</div>`,
        `</td></tr></table></td>`,
      ].join("");
    }),
    `</tr></table>`,
  ].join("");

  // The chips already say these four, so the panel would only repeat them.
  const chipLabels = body.severity === null
    ? new Set<string>()
    : new Set(SEVERITY_LEVELS.map((level) => body.severity!.labels[level]));
  const panelFacts = body.facts.filter((fact) => !chipLabels.has(fact.label));

  const factsHtml = panelFacts.length === 0 ? "" : [
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:20px 0 0">`,
    ...panelFacts.map((fact, index) => {
      const line = index === 0 ? "" : `border-top:1px solid ${LINE};`;
      return [
        `<tr>`,
        `<td class="fact-k" width="38%" style="width:38%;padding:9px 12px 9px 0;${line}font-family:${MONO};font-size:9.5px;line-height:16px;letter-spacing:.12em;text-transform:uppercase;color:${MUTED};vertical-align:top">${escapeHtml(fact.label)}</td>`,
        `<td class="fact-v" align="right" style="padding:9px 0;${line}font-family:${MONO};font-size:12.5px;line-height:17px;font-weight:600;color:${TX};vertical-align:top;word-break:break-word">${escapeHtml(fact.value)}</td>`,
        `</tr>`,
      ].join("");
    }),
    `</table>`,
  ].join("");

  // A bulletproof button: a table cell that carries the colour for clients that
  // drop the anchor's background, a VML rectangle for Outlook's Word engine, and
  // the URL spelled out underneath for the client that strips all three.
  const actionHtml = body.action === null || actionUrl === null ? "" : [
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:26px 0 0"><tr>`,
    `<td class="btnbg" align="center" bgcolor="${CYAN}" style="background:${CYAN}">`,
    `<!--[if mso]>`,
    `<v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word"`,
    ` href="${escapeHtml(actionUrl)}" style="height:44px;v-text-anchor:middle;width:300px" arcsize="0%"`,
    ` stroke="f" fillcolor="${CYAN}"><w:anchorlock/>`,
    `<center style="color:${BTN_INK};font-family:${SANS};font-size:13px;font-weight:bold;letter-spacing:.06em">${escapeHtml(body.action.label.toLocaleUpperCase(input.locale))}</center>`,
    `</v:roundrect>`,
    `<![endif]-->`,
    `<!--[if !mso]><!-- -->`,
    `<a class="btn" href="${escapeHtml(actionUrl)}"`,
    ` style="display:inline-block;background:${CYAN};padding:13px 26px;`,
    `font-family:${SANS};font-size:13px;line-height:17px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;`,
    `color:${BTN_INK};text-decoration:none">${escapeHtml(body.action.label)}</a>`,
    `<!--<![endif]-->`,
    `</td></tr></table>`,
    `<p class="url" style="margin:11px 0 0;font-family:${MONO};font-size:11px;line-height:1.5;color:${FAINT};word-break:break-all">${escapeHtml(actionUrl)}</p>`,
  ].join("");

  // The signature strip the interface's command dock signs its readings with.
  // The timestamp is this render's own moment, never a decorative one.
  const signature = [
    `<tr><td class="sigrow" style="border-top:1px solid ${LINE};padding:12px 22px">`,
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>`,
    `<td style="font-family:${MONO};font-size:9px;line-height:12px;letter-spacing:.12em;color:${MUTED};white-space:nowrap">`,
    `<span style="color:${accent}">&#9679;</span>&nbsp; SENTINEL · ${escapeHtml(shell.reading)} ${escapeHtml(readAt)}</td>`,
    `<td width="100%" style="vertical-align:middle;padding:0 12px" class="hs"><div style="border-top:1px solid ${LINE};font-size:1px;line-height:1px">&nbsp;</div></td>`,
    `<td class="hs" style="font-family:${MONO};font-size:9px;line-height:12px;letter-spacing:.12em;color:${FAINT};white-space:nowrap">OKAMI / SENTINEL</td>`,
    `</tr></table>`,
    `</td></tr>`,
  ].join("");

  const footerLinkHtml = footerUrl === null
    ? `<p class="foot-t" style="margin:8px 0 0;font-family:${SANS};font-size:12px;line-height:1.6;color:${MUTED}">${escapeHtml(shell.noLinks)}</p>`
    : linklessFooter
      ? ""
      : `<p style="margin:8px 0 0;font-family:${SANS};font-size:12px;line-height:1.6"><a class="foot-a" href="${escapeHtml(footerUrl)}" style="color:${CYAN};text-decoration:underline">${escapeHtml(footerLabel)}</a></p>`;

  // The preview line most clients show next to the subject. Hidden in the body,
  // then padded, so the header's words do not become the preview instead.
  const preheader = (body.paragraphs[0] ?? body.heading).slice(0, 140);

  const html = [
    `<!doctype html><html lang="${escapeHtml(input.locale)}" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office"><head>`,
    `<meta charset="utf-8">`,
    `<meta name="viewport" content="width=device-width,initial-scale=1">`,
    `<meta http-equiv="x-ua-compatible" content="ie=edge">`,
    // Dark is the only scheme: the design does not switch, it *is* the theme.
    `<meta name="color-scheme" content="dark">`,
    `<meta name="supported-color-schemes" content="dark">`,
    `<title>${escapeHtml(body.subject)}</title>`,
    `<!--[if mso]><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml><![endif]-->`,
    `<style>${HEAD_STYLE}</style>`,
    `</head>`,
    `<body style="margin:0;padding:0;background:${PAGE};color:${TX}" bgcolor="${PAGE}">`,
    `<div style="display:none;max-height:0;overflow:hidden;mso-hide:all">${escapeHtml(preheader)}</div>`,
    `<div style="display:none;max-height:0;overflow:hidden;mso-hide:all">${"&#8203;&#847;".repeat(40)}</div>`,
    `<table role="presentation" class="page" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${PAGE}" style="background:${PAGE};width:100%">`,
    `<tr><td align="center" style="padding:26px 12px 34px">`,
    `<table role="presentation" class="card" width="600" cellpadding="0" cellspacing="0" border="0" bgcolor="${CARD}" style="width:100%;max-width:600px;background:${CARD};border:1px solid ${LINE}">`,
    tickTop,
    header,
    hero,
    `<tr><td class="pad" style="padding:0 22px 28px">`,
    paragraphs,
    severityHtml,
    factsHtml,
    actionHtml,
    `</td></tr>`,
    signature,
    `<tr><td class="foot" bgcolor="#0a0a11" style="background:#0a0a11;border-top:1px solid ${LINE};padding:16px 22px 18px">`,
    `<p class="foot-t" style="margin:0;font-family:${SANS};font-size:12px;line-height:1.6;color:${MUTED}">${escapeHtml(body.reason)}</p>`,
    footerLinkHtml,
    `<p class="sig" style="margin:13px 0 0;font-family:${MONO};font-size:9.5px;line-height:1.4;letter-spacing:.08em;color:${FAINT}">${escapeHtml(shell.signature)}</p>`,
    `</td></tr>`,
    tickBottom,
    `</table>`,
    `</td></tr></table>`,
    `</body></html>`,
  ].join("");

  // Pure 7-bit ASCII: no client can mis-decode it under a single-byte charset
  // regardless of what it does with the `<meta charset="utf-8">` above.
  return { subject: body.subject, html: toAsciiEntities(html), text };
}

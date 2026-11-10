/**
 * Shared layout of every email (booking notifications and marketing): the
 * site's colours and type, one centred card up to 560 px wide that narrows on
 * phones, details as label-above-value rows (no side-by-side columns to
 * break on small screens). Every email has a plain-text twin built from the
 * same content. Dynamic values are escaped; subjects and values are single
 * lines without control characters.
 *
 * Web fonts are not loaded (mail clients block or ignore them): the site's
 * families come first, then common fallbacks.
 */

/** Colour tokens of the site (my-app, src/app/globals.css). */
export const EMAIL_COLORS = {
  page: "#f9f7f5", // --color-secondary-50
  card: "#fdfdfd", // --color-base-white
  panel: "#f4efe8", // --color-secondary-100
  border: "#d7c5aa", // --color-secondary-200
  accent: "#cd984f", // --color-primary-200 (gold)
  onAccent: "#131212", // --color-on-gold
  heading: "#131212", // --color-base-black
  text: "#414141", // --color-gray-900
};

const SERIF = "Faustina, Georgia, 'Times New Roman', serif";
const SANS = "Montserrat, Arial, Helvetica, sans-serif";

const HTML_ESCAPES: Readonly<Record<string, string>> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export const escapeHtml = (value: string): string => value.replace(/[&<>"']/g, (char) => HTML_ESCAPES[char] ?? char);

/** Single line, no control characters (subjects and detail values). */
export const oneLine = (value: string): string =>
  Array.from(value, (char) => {
    const code = char.charCodeAt(0);
    return code < 0x20 || code === 0x7f ? " " : char;
  })
    .join("")
    .replace(/ {2,}/g, " ")
    .trim();

export type EmailDetail = [label: string, value: string];

export type EmailContent = {
  subject: string;
  /** Short line shown by mail clients next to the subject; not displayed in the body. */
  preheader: string;
  /** The outcome in a few words: "Rendez-vous confirmé". */
  title: string;
  paragraphs: string[];
  details?: EmailDetail[];
  /** One button; the URL is built by the server and still escaped. */
  action?: { label: string; url: string };
  /** Smaller text after the details or the button. */
  notes?: string[];
  /** Last lines, e.g. "À bientôt," and the sender name from configuration. */
  signature: string[];
};

export type RenderedEmail = { subject: string; html: string; text: string };

const paragraph = (text: string, style: string) => `<p style="margin:0 0 16px;${style}">${escapeHtml(text)}</p>`;

export const renderEmailLayout = (content: EmailContent): RenderedEmail => {
  const details = (content.details ?? []).map(([label, value]): EmailDetail => [oneLine(label), oneLine(value)]);
  const notes = content.notes ?? [];
  const body = `font-family:${SANS};font-size:16px;line-height:1.6;color:${EMAIL_COLORS.text}`;

  const detailRows = details
    .map(
      ([label, value], index) =>
        `<tr><td style="padding:${index === 0 ? "0" : "12px"} 0 0;font-family:${SANS};">` +
        `<div style="font-size:12px;line-height:1.4;letter-spacing:0.04em;text-transform:uppercase;color:${EMAIL_COLORS.text}">${escapeHtml(label)}</div>` +
        `<div style="font-size:16px;line-height:1.5;font-weight:600;color:${EMAIL_COLORS.heading}">${escapeHtml(value)}</div>` +
        `</td></tr>`,
    )
    .join("\n");

  const html = [
    "<!doctype html>",
    '<html lang="fr">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="color-scheme" content="light">',
    `<title>${escapeHtml(oneLine(content.subject))}</title>`,
    "<style>@media (max-width:600px){.card-pad{padding:24px 20px !important}.page-pad{padding:16px 8px !important}}</style>",
    "</head>",
    `<body style="margin:0;padding:0;background-color:${EMAIL_COLORS.page}">`,
    `<div style="display:none;max-height:0;overflow:hidden;opacity:0">${escapeHtml(oneLine(content.preheader))}</div>`,
    `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background-color:${EMAIL_COLORS.page}">`,
    '<tr><td class="page-pad" align="center" style="padding:32px 16px">',
    `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:560px;background-color:${EMAIL_COLORS.card};border:1px solid ${EMAIL_COLORS.border};border-radius:12px;border-top:4px solid ${EMAIL_COLORS.accent}">`,
    `<tr><td class="card-pad" style="padding:32px">`,
    `<h1 style="margin:0 0 20px;font-family:${SERIF};font-size:26px;line-height:1.25;font-weight:600;color:${EMAIL_COLORS.heading}">${escapeHtml(oneLine(content.title))}</h1>`,
    ...content.paragraphs.map((text) => paragraph(text, body)),
    ...(details.length === 0
      ? []
      : [
          `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin:8px 0 24px;background-color:${EMAIL_COLORS.panel};border-radius:8px">`,
          `<tr><td style="padding:20px"><table role="presentation" width="100%" cellspacing="0" cellpadding="0">`,
          detailRows,
          "</table></td></tr></table>",
        ]),
    ...(content.action === undefined
      ? []
      : [
          `<table role="presentation" cellspacing="0" cellpadding="0" style="margin:8px 0 24px"><tr>`,
          `<td style="border-radius:999px;background-color:${EMAIL_COLORS.accent}">`,
          `<a href="${escapeHtml(content.action.url)}" style="display:inline-block;padding:12px 28px;font-family:${SANS};font-size:16px;font-weight:600;color:${EMAIL_COLORS.onAccent};text-decoration:none;border-radius:999px">${escapeHtml(content.action.label)}</a>`,
          "</td></tr></table>",
        ]),
    ...notes.map((text) => paragraph(text, `${body};font-size:14px`)),
    `<p style="margin:8px 0 0;${body}">${content.signature.map((line) => escapeHtml(oneLine(line))).join("<br>")}</p>`,
    "</td></tr></table>",
    "</td></tr></table>",
    "</body>",
    "</html>",
  ].join("\n");

  const text = [
    oneLine(content.title),
    "",
    ...content.paragraphs.flatMap((text) => [text, ""]),
    ...(details.length === 0 ? [] : [...details.map(([label, value]) => `${label} : ${value}`), ""]),
    ...(content.action === undefined ? [] : [`${content.action.label} : ${content.action.url}`, ""]),
    ...notes.flatMap((text) => [text, ""]),
    ...content.signature.map(oneLine),
  ].join("\n");

  return { subject: oneLine(content.subject), html, text };
};

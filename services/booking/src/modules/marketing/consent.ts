import type { MarketingConsentSource, MarketingSubscription } from "../../generated/prisma/client.js";
import { AppError } from "../../shared/errors/app-error.js";

/**
 * Version of the marketing consent text shown next to every opt-in (sign-up
 * checkbox, subscription form, re-subscribe button). The frontend sends the
 * version it displayed; it is stored with the consent. Changing the wording
 * means a new version here and in the frontend at the same time.
 */
export const MARKETING_CONSENT_TEXT_VERSION = "2026-10-28.fr.1";

export const requireCurrentConsentText = (version: string): string => {
  if (version !== MARKETING_CONSENT_TEXT_VERSION) {
    throw new AppError(409, "The consent text shown is outdated; reload and show the current one", {
      code: "CONSENT_TEXT_OUTDATED",
      details: { currentConsentTextVersion: MARKETING_CONSENT_TEXT_VERSION },
    });
  }
  return version;
};

export type ConsentRequest = {
  source: MarketingConsentSource;
  textVersion: string;
};

/** Marketing status as shown in a profile (only for a verified email). */
export type MarketingStatus = {
  subscribed: boolean;
  pendingConfirmation: boolean;
  consentGivenAt: string | null;
  consentSource: MarketingConsentSource | null;
  consentTextVersion: string | null;
  unsubscribedAt: string | null;
};

export const toMarketingStatus = (row: MarketingSubscription | null): MarketingStatus => ({
  subscribed: row?.subscribed ?? false,
  pendingConfirmation: row !== null && !row.subscribed && row.confirmationNonce !== null,
  consentGivenAt: row?.consentGivenAt?.toISOString() ?? null,
  consentSource: row?.consentSource ?? null,
  consentTextVersion: row?.consentTextVersion ?? null,
  unsubscribedAt: row?.unsubscribedAt?.toISOString() ?? null,
});

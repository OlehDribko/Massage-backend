import { clientReason, type AdminRecipientStatus, type NotificationState, type ClientNotificationReason } from "../../notifications/status.js";
import { ALLOWED_TRANSITIONS, type ContactChannel, type GiftCardStatus } from "./gift-card.schema.js";
import type { GiftCardRequestWithHistory } from "./gift-card.service.js";

/**
 * The studio's email about the request as the client may see it: separate
 * from `status` (a failed email never changes the request); reasons are the
 * plain client set, nothing about provider or configuration.
 */
export type GiftCardClientNotification = { status: NotificationState; reason: ClientNotificationReason | null };

type GiftCardViewBase = {
  id: string;
  number: number;
  status: GiftCardStatus;
  amountCents: number;
  currency: string;
  description: string | null;
  preferredContactChannel: ContactChannel;
  createdAt: string;
};

/** What the submitting client gets back. No contacts: they are the client's own. */
export type ClientGiftCardRequestView = GiftCardViewBase & {
  /** null when emails are off on this server. */
  notification: GiftCardClientNotification | null;
};

export type GiftCardHistoryEntry = {
  fromStatus: GiftCardStatus | null;
  toStatus: GiftCardStatus;
  at: string;
  /** Current name and email of the profile that made the change. */
  by: { profileId: string; role: "client" | "admin"; name: string | null; email: string | null };
};

export type AdminGiftCardRequestView = GiftCardViewBase & {
  /** Snapshot at submission; later profile changes do not touch it. Phone not verified. */
  client: { profileId: string; name: string; email: string; phone: string };
  updatedAt: string;
  /** Statuses an admin may set next (UI hint; the server re-checks). */
  allowedStatuses: GiftCardStatus[];
  history: GiftCardHistoryEntry[];
  /** The studio's email; null when emails are off on this server. */
  notification: AdminRecipientStatus | null;
};

const common = (request: GiftCardRequestWithHistory) => ({
  id: request.id,
  number: request.number,
  status: request.status,
  amountCents: request.amountCents,
  currency: request.currency,
  description: request.description,
  preferredContactChannel: request.preferredContactChannel,
  createdAt: request.createdAt.toISOString(),
});

/** `notification`: undefined = emails off; a pending state before the event is planned. */
export const toClientGiftCardView = (
  request: GiftCardRequestWithHistory,
  notification: AdminRecipientStatus | undefined | null,
): ClientGiftCardRequestView => ({
  ...common(request),
  notification:
    notification === null || notification === undefined
      ? null
      : { status: notification.status, reason: clientReason(notification) },
});

export const toAdminGiftCardView = (
  request: GiftCardRequestWithHistory,
  notification: AdminRecipientStatus | undefined | null,
): AdminGiftCardRequestView => ({
  ...common(request),
  client: {
    profileId: request.clientProfileId,
    name: request.clientName,
    email: request.clientEmail,
    phone: request.clientPhone,
  },
  updatedAt: request.updatedAt.toISOString(),
  allowedStatuses: [...ALLOWED_TRANSITIONS[request.status]],
  history: request.statusChanges.map((change) => ({
    fromStatus: change.fromStatus,
    toStatus: change.toStatus,
    at: change.changedAt.toISOString(),
    by: {
      profileId: change.changedByProfileId,
      role: change.changedByRole,
      name: change.changedBy.name,
      email: change.changedBy.email,
    },
  })),
  notification: notification ?? null,
});

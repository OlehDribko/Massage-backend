-- Closures of dates for new bookings and moves (docs/booking.md, "Закриття дат").
-- Additive only: a new table; existing schedule, exceptions and bookings are untouched.
CREATE TABLE "ScheduleClosure" (
    "date" DATE NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ScheduleClosure_pkey" PRIMARY KEY ("date")
);

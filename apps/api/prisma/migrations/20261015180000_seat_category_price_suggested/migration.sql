-- Whether a ticket category's price is one a layout template worked out rather than one the
-- organizer typed or accepted (E1). Additive with a false default: every existing category keeps
-- reading as a price somebody chose, exactly as before. The editor shows a true one as
-- "suggested" until it is changed or accepted, and publishing a draft accepts what it shows.
ALTER TABLE "SeatCategory" ADD COLUMN "priceSuggested" BOOLEAN NOT NULL DEFAULT false;

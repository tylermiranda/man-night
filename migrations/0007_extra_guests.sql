-- Extra guests on RSVPs and 5-minute pre-event headcount notification tracking
ALTER TABLE rsvps ADD COLUMN extra_guests INTEGER NOT NULL DEFAULT 0;
ALTER TABLE dinners ADD COLUMN pre_event_sent_at TEXT;

-- Add optional extra guest names to RSVPs
ALTER TABLE rsvps ADD COLUMN extra_guest_names TEXT NOT NULL DEFAULT '';

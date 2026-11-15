-- Add optional reason text to Tuesday/Wednesday night votes
ALTER TABLE night_votes ADD COLUMN reason TEXT NOT NULL DEFAULT '';

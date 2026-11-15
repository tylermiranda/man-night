-- Issue reports: screenshots pasted or attached from the PWA

ALTER TABLE issue_reports ADD COLUMN screenshot_mime TEXT;
ALTER TABLE issue_reports ADD COLUMN screenshot_byte_size INTEGER;
ALTER TABLE issue_reports ADD COLUMN screenshot_width INTEGER;
ALTER TABLE issue_reports ADD COLUMN screenshot_height INTEGER;

CREATE TABLE IF NOT EXISTS issue_report_screenshots (
  report_id INTEGER PRIMARY KEY REFERENCES issue_reports(id) ON DELETE CASCADE,
  image_base64 TEXT NOT NULL
);

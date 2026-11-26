// Forces the test database before any module opens a pool.
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL || 'postgres://kaizen:kaizen@127.0.0.1:5432/kaizen_sensei_test';
process.env.COOKIE_SECURE = '0';
process.env.STUDIO_TZ = 'Asia/Dubai';
process.env.CRON_SECRET = process.env.CRON_SECRET || 'test-cron-secret';
process.env.APP_BASE_URL = '';
for (const key of [
  'MB_API_KEY', 'MB_SITE_ID', 'MB_USERNAME', 'MB_PASSWORD', 'MB_LOCATION_IDS',
  'MB_SCHEDULE_PUBLISH', 'SCHEDULE_PUBLISH_ENABLED', 'SCHEDULE_AUTO_DRAFT',
  'SLACK_BOT_TOKEN', 'SLACK_ALERT_CHANNEL',
  'WA_TOKEN', 'WA_PHONE_NUMBER_ID', 'WA_TEMPLATE_NAME', 'FRONT_DESK_WA_E164',
  'RESEND_API_KEY', 'ALERT_EMAIL_FROM', 'ALERT_EMAIL_TO',
]) delete process.env[key];

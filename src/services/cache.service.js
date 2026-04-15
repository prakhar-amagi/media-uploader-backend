import pkg from "pg";
const { Pool } = pkg;

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

export async function cachePayload(channelID, channelName, payload) {
  await pool.query(
    `
    INSERT INTO stormforge_cache (channel_id, channel_name, payload, last_fetched_at)
    VALUES ($1, $2, $3, NOW())
    ON CONFLICT (channel_id)
    DO UPDATE SET payload=$3, last_fetched_at=NOW()
    `,
    [channelID, channelName, payload]
  );
}

export async function getCachedPayload(channelID) {
  const res = await pool.query(
    "SELECT payload FROM stormforge_cache WHERE channel_id=$1",
    [channelID]
  );
  return res.rows[0]?.payload;
}


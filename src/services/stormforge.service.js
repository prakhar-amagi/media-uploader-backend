import axios from "axios";

const client = axios.create({
  baseURL: process.env.STORMFORGE_BASE_URL,
  headers: {
    Authorization: `Bearer ${process.env.STORMFORGE_BEARER_TOKEN}`,
    "Content-Type": "application/json"
  }
});

export async function getStormforge(channelID) {
  const { data } = await client.get(`/${channelID}`);
  return data;
}

export async function updateStormforge(channelID, payload) {
  await client.put(`/${channelID}`, payload);
}


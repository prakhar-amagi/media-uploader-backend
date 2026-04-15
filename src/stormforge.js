import "./env.js";
import axios from "axios";

const client = axios.create({
  baseURL: process.env.STORMFORGE_BASE_URL,
  headers: {
    Authorization: `Bearer ${process.env.STORMFORGE_BEARER}`,
    "Content-Type": "application/json"
  }
});

export async function getPromos(channelId) {
  const res = await client.get(`/${channelId}`);
  return res.data;
}

// IMPORTANT: PUT THE FULL UPDATED OBJECT BACK
export async function putPromos(channelId, fullData) {
  const res = await client.put(`/${channelId}`, fullData);
  return res.data;
}

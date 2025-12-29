import { SpotifyApi, type AccessToken } from "@spotify/web-api-ts-sdk";

const DEFAULT_EXPIRES_IN = 3600;

/**
 * Creates a Spotify Web API SDK instance that simply wraps a raw access token.
 * The SDK expects the full token payload, so we synthesize the minimal fields.
 */
export function createSpotifySdk(accessToken: string, clientId = "") {
  const token: AccessToken = {
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: DEFAULT_EXPIRES_IN,
    refresh_token: "",
    expires: Date.now() + DEFAULT_EXPIRES_IN * 1000,
  };

  return SpotifyApi.withAccessToken(clientId, token);
}

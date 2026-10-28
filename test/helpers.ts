export function credentialBearingVideoUrl(): string {
  const url = new URL('https://videos.example.test/clip');
  url.username = 'athlete';
  url.password = 'password';
  return url.toString();
}

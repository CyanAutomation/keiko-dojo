const BLOCKED_HOST_LABELS = new Set(['localhost', 'metadata.google.internal']);
const BLOCKED_HOST_SUFFIXES = ['.localhost', '.local', '.localdomain'];

const IPV4_BLOCKED_CIDRS: Array<[number, number]> = [
  [ipv4ToInt('0.0.0.0'), 8], // "this" network / invalid source
  [ipv4ToInt('10.0.0.0'), 8], // RFC1918
  [ipv4ToInt('100.64.0.0'), 10], // CGNAT shared space
  [ipv4ToInt('127.0.0.0'), 8], // loopback
  [ipv4ToInt('169.254.0.0'), 16], // link-local
  [ipv4ToInt('172.16.0.0'), 12], // RFC1918
  [ipv4ToInt('192.0.0.0'), 24], // IETF protocol assignments
  [ipv4ToInt('192.0.2.0'), 24], // TEST-NET-1
  [ipv4ToInt('192.88.99.0'), 24], // 6to4 relay anycast (deprecated)
  [ipv4ToInt('192.168.0.0'), 16], // RFC1918
  [ipv4ToInt('198.18.0.0'), 15], // benchmarking
  [ipv4ToInt('198.51.100.0'), 24], // TEST-NET-2
  [ipv4ToInt('203.0.113.0'), 24], // TEST-NET-3
  [ipv4ToInt('224.0.0.0'), 4], // multicast + reserved space
];

const IPV6_BLOCKED_CIDRS: Array<[bigint, number]> = [
  [ipv6ToBigInt('::'), 128], // unspecified
  [ipv6ToBigInt('::1'), 128], // loopback
  [ipv6ToBigInt('::ffff:0:0'), 96], // IPv4-mapped IPv6 (evaluate mapped IPv4)
  [ipv6ToBigInt('64:ff9b::'), 96], // IPv4/IPv6 translation prefix
  [ipv6ToBigInt('100::'), 64], // discard-only prefix
  [ipv6ToBigInt('2001::'), 32], // TEREDO
  [ipv6ToBigInt('2001:2::'), 48], // benchmarking
  [ipv6ToBigInt('2001:db8::'), 32], // documentation
  [ipv6ToBigInt('fc00::'), 7], // unique local addresses
  [ipv6ToBigInt('fe80::'), 10], // link-local unicast
  [ipv6ToBigInt('ff00::'), 8], // multicast
];

export function isBlockedNetworkHostname(hostname: string): boolean {
  const normalizedHost = normalizeNetworkHostname(hostname);
  if (!normalizedHost) {
    return true;
  }

  if (
    looksLikeIpLiteral(normalizedHost) &&
    getIpVersion(normalizedHost) === 0
  ) {
    return true;
  }

  if (isBlockedByHostnamePolicy(normalizedHost)) {
    return true;
  }

  const ipVersion = getIpVersion(normalizedHost);
  if (ipVersion === 4) {
    return isBlockedIPv4(normalizedHost);
  }

  if (ipVersion === 6) {
    const mapped = extractMappedIpv4(normalizedHost);
    if (mapped) {
      return isBlockedIPv4(mapped);
    }

    return isBlockedIPv6(normalizedHost);
  }

  return false;
}

export function normalizeNetworkHostname(hostname: string): string {
  const lowered = hostname.trim().toLowerCase().replace(/\.+$/, '');
  if (lowered.startsWith('[') && lowered.endsWith(']')) {
    return lowered.slice(1, -1);
  }

  return lowered;
}

function isBlockedByHostnamePolicy(hostname: string): boolean {
  if (BLOCKED_HOST_LABELS.has(hostname)) {
    return true;
  }

  return BLOCKED_HOST_SUFFIXES.some((suffix) => hostname.endsWith(suffix));
}

function looksLikeIpLiteral(value: string): boolean {
  return value.includes(':') || /^\d+(?:\.\d+){0,3}$/.test(value);
}

function isBlockedIPv4(ipv4: string): boolean {
  const value = ipv4ToInt(ipv4);
  return IPV4_BLOCKED_CIDRS.some(([network, prefix]) =>
    isInIPv4Cidr(value, network, prefix)
  );
}

function isBlockedIPv6(ipv6: string): boolean {
  const value = ipv6ToBigInt(ipv6);
  return IPV6_BLOCKED_CIDRS.some(([network, prefix]) =>
    isInIPv6Cidr(value, network, prefix)
  );
}

function extractMappedIpv4(ipv6: string): string | null {
  const normalized = ipv6.toLowerCase();
  const mappedPrefix = '::ffff:';
  if (!normalized.startsWith(mappedPrefix)) {
    return null;
  }

  const remainder = normalized.slice(mappedPrefix.length);

  // Check for dotted-decimal notation first
  if (getIpVersion(remainder) === 4) {
    return remainder;
  }

  // Handle hexadecimal notation: ::ffff:c0a8:0001 -> 192.168.0.1
  const hexMatch = remainder.match(/^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hexMatch) {
    const high = parseInt(hexMatch[1], 16);
    const low = parseInt(hexMatch[2], 16);
    return `${(high >> 8) & 0xff}.${high & 0xff}.${(low >> 8) & 0xff}.${low & 0xff}`;
  }

  return null;
}

function ipv4ToInt(ipv4: string): number {
  const octets = ipv4.split('.').map((part) => Number(part));

  if (
    octets.length !== 4 ||
    octets.some((octet) => isNaN(octet) || octet < 0 || octet > 255)
  ) {
    throw new Error(`Invalid IPv4 address: ${ipv4}`);
  }

  return (
    (((octets[0] << 24) >>> 0) |
      ((octets[1] << 16) >>> 0) |
      ((octets[2] << 8) >>> 0) |
      (octets[3] >>> 0)) >>>
    0
  );
}

function getIpVersion(value: string): 0 | 4 | 6 {
  if (isValidIpv4(value)) {
    return 4;
  }

  if (isValidIpv6(value)) {
    return 6;
  }

  return 0;
}

function isValidIpv4(value: string): boolean {
  try {
    ipv4ToInt(value);
    return true;
  } catch {
    return false;
  }
}

function isValidIpv6(value: string): boolean {
  if (!value.includes(':')) {
    return false;
  }

  try {
    ipv6ToBigInt(value);
    return true;
  } catch {
    return false;
  }
}

function isInIPv4Cidr(value: number, network: number, prefix: number): boolean {
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (value & mask) === (network & mask);
}

function ipv6ToBigInt(ipv6: string): bigint {
  const parts = ipv6.split('::');

  // IPv6 can only have one occurrence of '::'
  if (parts.length > 2) {
    throw new Error('Invalid IPv6 address: multiple :: sequences');
  }

  const headParts = parts[0] ? parts[0].split(':').filter(Boolean) : [];
  const tailParts =
    parts[1] !== undefined ? parts[1].split(':').filter(Boolean) : [];

  const expandedHead = expandIpv6Parts(headParts);
  const expandedTail = expandIpv6Parts(tailParts);

  const missingGroups = 8 - (expandedHead.length + expandedTail.length);
  const groups = [
    ...expandedHead,
    ...Array(Math.max(missingGroups, 0)).fill(0),
    ...expandedTail,
  ];

  if (groups.length !== 8) {
    throw new Error('Invalid IPv6 address: incorrect group count');
  }

  return groups.reduce(
    (acc, group) => (acc << BigInt(16)) | BigInt(group),
    BigInt(0)
  );
}

function expandIpv6Parts(parts: string[]): number[] {
  const expanded: number[] = [];

  for (const part of parts) {
    if (part.includes('.')) {
      const ipv4 = ipv4ToInt(part);
      expanded.push((ipv4 >>> 16) & 0xffff, ipv4 & 0xffff);
      continue;
    }

    expanded.push(parseInt(part || '0', 16));
  }

  return expanded;
}

function isInIPv6Cidr(value: bigint, network: bigint, prefix: number): boolean {
  const bits = BigInt(128);
  const shift = bits - BigInt(prefix);
  const mask =
    prefix === 0
      ? BigInt(0)
      : ((BigInt(1) << bits) - BigInt(1)) ^ ((BigInt(1) << shift) - BigInt(1));
  return (value & mask) === (network & mask);
}

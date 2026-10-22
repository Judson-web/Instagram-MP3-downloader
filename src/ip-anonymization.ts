import net = require("node:net");

export function maskClientIp(ipAddress: string): string {
  let value = String(ipAddress || "").trim().replace(/^\[|\]$/g, "").split("%")[0].toLowerCase();
  if (!value || value.length > 100) return "unknown";

  const ipv4Subnet = (raw: string): string | null => {
    if (net.isIP(raw) !== 4) return null;
    const octets = raw.split(".").map(Number);
    if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return null;
    // IPv4 is truncated to /24 before the keyed hash is calculated.
    return octets.slice(0, 3).join(".") + ".0/24";
  };

  // Normalize IPv4-mapped IPv6 addresses to the equivalent IPv4 /24.
  if (value.startsWith("::ffff:")) {
    const mappedTail = value.slice(7);
    const dotted = ipv4Subnet(mappedTail);
    if (dotted) return dotted;
    const mappedHex = mappedTail.match(/^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (mappedHex) {
      const first = parseInt(mappedHex[1], 16);
      const second = parseInt(mappedHex[2], 16);
      const octets = [first >> 8, first & 255, second >> 8, second & 255];
      return octets.slice(0, 3).join(".") + ".0/24";
    }
  }

  const v4 = ipv4Subnet(value);
  if (v4) return v4;
  if (net.isIP(value) !== 6) return "unknown";

  // Expand an optional embedded IPv4 tail into two IPv6 groups.
  const dottedPart = value.split(":").find((part) => part.includes("."));
  if (dottedPart) {
    const dotted = dottedPart;
    const octets = dotted.split(".").map(Number);
    if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return "unknown";
    const replacement = [((octets[0] << 8) | octets[1]).toString(16), ((octets[2] << 8) | octets[3]).toString(16)].join(":");
    value = value.replace(dotted, replacement);
  }

  const halves = value.split("::");
  if (halves.length > 2) return "unknown";
  const left = halves[0] ? halves[0].split(":").filter(Boolean) : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":").filter(Boolean) : [];
  const zeroCount = 8 - left.length - right.length;
  if (zeroCount < 0 || (halves.length === 1 && zeroCount !== 0)) return "unknown";
  const groups = [...left, ...Array(zeroCount).fill("0"), ...right];
  if (groups.length !== 8 || groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))) return "unknown";
  // IPv6 is truncated to /64. Only this network prefix is fed into HMAC-SHA-256.
  return groups.slice(0, 4).map((group) => parseInt(group, 16).toString(16)).join(":") + "::/64";
}

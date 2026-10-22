import test = require("node:test");
import assert = require("node:assert/strict");
import { maskClientIp } from "./ip-anonymization";

test("IPv4 addresses are truncated to /24", () => {
  assert.equal(maskClientIp("203.0.113.47"), "203.0.113.0/24");
  assert.equal(maskClientIp("203.0.113.250"), "203.0.113.0/24");
  assert.equal(maskClientIp("203.0.114.2"), "203.0.114.0/24");
});

test("IPv4-mapped IPv6 dotted addresses use the IPv4 /24", () => {
  assert.equal(maskClientIp("::ffff:192.0.2.128"), "192.0.2.0/24");
});

test("IPv4-mapped IPv6 hexadecimal addresses use the IPv4 /24", () => {
  assert.equal(maskClientIp("::ffff:c000:0280"), "192.0.2.0/24");
});

test("IPv6 addresses are truncated to /64", () => {
  assert.equal(maskClientIp("2001:db8:abcd:12::1"), "2001:db8:abcd:12::/64");
  assert.equal(maskClientIp("2001:db8:abcd:12:ffff:eeee:dddd:cccc"), "2001:db8:abcd:12::/64");
  assert.notEqual(maskClientIp("2001:db8:abcd:13::1"), "2001:db8:abcd:12::/64");
});

test("invalid or missing addresses never pass through unmasked", () => {
  assert.equal(maskClientIp("unknown"), "unknown");
  assert.equal(maskClientIp("not-an-ip"), "unknown");
  assert.equal(maskClientIp(""), "unknown");
});

"""A 256x256 app icon, written straight to PNG: an indigo rounded square with
the same upload arrow the web app uses in its header."""
import struct, zlib, math

S = 256
BG = (5, 140, 53)           # BetLive green, sampled from their Sign In button
FG = (255, 255, 255)
RADIUS = 56

def rounded_alpha(x, y):
    """Coverage of the rounded square at this pixel, anti-aliased."""
    cx = min(max(x, RADIUS), S - RADIUS)
    cy = min(max(y, RADIUS), S - RADIUS)
    d = math.hypot(x - cx, y - cy)
    return max(0.0, min(1.0, RADIUS - d + 0.5))

def arrow_alpha(x, y):
    """Upward arrow: a stem plus a triangular head."""
    cx = S / 2
    a = 0.0
    # stem
    if abs(x - cx) <= 15 and 108 <= y <= 186:
        a = 1.0
    # head: widens as it goes down from the tip
    tip_y, head_bottom = 70, 128
    if tip_y <= y <= head_bottom:
        half = (y - tip_y) * 0.95
        if abs(x - cx) <= half:
            a = 1.0
    # base bar, so it reads as "send" rather than just an arrow
    if 196 <= y <= 214 and abs(x - cx) <= 62:
        a = 1.0
    return a

rows = []
for y in range(S):
    row = bytearray([0])  # filter byte
    for x in range(S):
        px, py = x + 0.5, y + 0.5
        outer = rounded_alpha(px, py)
        glyph = arrow_alpha(px, py)
        r = round(BG[0] * (1 - glyph) + FG[0] * glyph)
        g = round(BG[1] * (1 - glyph) + FG[1] * glyph)
        b = round(BG[2] * (1 - glyph) + FG[2] * glyph)
        row += bytes((r, g, b, round(255 * outer)))
    rows.append(bytes(row))

def chunk(tag, data):
    out = struct.pack('>I', len(data)) + tag + data
    return out + struct.pack('>I', zlib.crc32(tag + data) & 0xFFFFFFFF)

png = b'\x89PNG\r\n\x1a\n'
png += chunk(b'IHDR', struct.pack('>IIBBBBB', S, S, 8, 6, 0, 0, 0))
png += chunk(b'IDAT', zlib.compress(b''.join(rows), 9))
png += chunk(b'IEND', b'')

with open('desktop/build/icon.png', 'wb') as f:
    f.write(png)
print(f'wrote desktop/build/icon.png ({len(png)} bytes, {S}x{S})')

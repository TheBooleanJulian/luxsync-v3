"""Recolour an RGBA PNG with the Unified UI signal gradient (135deg, cyan -> magenta),
keeping its alpha. Also clears a stray semi-transparent column at x=0.
Usage: python recolor_mark.py in.png out.png"""
import struct, sys, zlib

CYAN = (0x00, 0xE5, 0xFF)      # --cyan (dark)
MAGENTA = (0xFF, 0x2B, 0xD6)   # --magenta (dark)


def read_png(path):
    d = open(path, "rb").read()
    w, h, bd, ct = struct.unpack(">IIBB", d[16:26])
    assert bd == 8 and ct == 6, "expects 8-bit RGBA"
    i, idat = 8, b""
    while i < len(d):
        n = struct.unpack(">I", d[i:i + 4])[0]
        if d[i + 4:i + 8] == b"IDAT":
            idat += d[i + 8:i + 8 + n]
        i += 12 + n
    raw, bpp, stride = zlib.decompress(idat), 4, w * 4
    rows, prev, p = [], bytearray(stride), 0
    for _ in range(h):
        f = raw[p]; line = bytearray(raw[p + 1:p + 1 + stride]); p += 1 + stride
        for x in range(stride):
            a = line[x - bpp] if x >= bpp else 0
            b = prev[x]
            c = prev[x - bpp] if x >= bpp else 0
            if f == 1: line[x] = (line[x] + a) & 255
            elif f == 2: line[x] = (line[x] + b) & 255
            elif f == 3: line[x] = (line[x] + ((a + b) >> 1)) & 255
            elif f == 4:
                pa, pb, pc = abs(b - c), abs(a - c), abs(a + b - 2 * c)
                line[x] = (line[x] + (a if pa <= pb and pa <= pc else b if pb <= pc else c)) & 255
        rows.append(line); prev = line
    return w, h, rows


def write_png(path, w, h, rows):
    def chunk(t, data):
        return struct.pack(">I", len(data)) + t + data + struct.pack(">I", zlib.crc32(t + data) & 0xFFFFFFFF)
    raw = b"".join(b"\x00" + bytes(r) for r in rows)
    png = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0))
    png += chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b"")
    open(path, "wb").write(png)


def main(src, dst):
    w, h, rows = read_png(src)
    span = w + h
    for y, r in enumerate(rows):
        for x in range(w):
            t = (x + y) / span  # 135deg: top-left cyan, bottom-right magenta
            r[x * 4:x * 4 + 3] = bytes(round(c0 + (c1 - c0) * t) for c0, c1 in zip(CYAN, MAGENTA))
            # The source's solid area is ~87% opaque; scale so it is fully opaque, edges stay soft.
            r[x * 4 + 3] = min(255, round(r[x * 4 + 3] * 255 / 223))
        r[3] = 0  # stray line at x=0
    write_png(dst, w, h, rows)
    print("wrote", dst, w, h)


if __name__ == "__main__":
    main(*sys.argv[1:3])

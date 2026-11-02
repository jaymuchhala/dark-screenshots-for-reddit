# Draws the icons: a rounded square, bright on one side of a diagonal, dark on the other.
import struct, zlib, sys

def png(size):
    rows, r = b'', size * 0.22
    for y in range(size):
        row = bytearray([0])
        for x in range(size):
            dx = max(r - x - .5, x + .5 - (size - r), 0)
            dy = max(r - y - .5, y + .5 - (size - r), 0)
            a = max(0, min(1, r - (dx * dx + dy * dy) ** .5 + .5))
            c = (246, 247, 248) if x + y < size - 1 else (24, 27, 30)
            row += bytes((*c, int(a * 255)))
        rows += bytes(row)
    def chunk(t, d):
        return struct.pack('>I', len(d)) + t + d + struct.pack('>I', zlib.crc32(t + d))
    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', size, size, 8, 6, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(rows)) + chunk(b'IEND', b'')

for s in (16, 32, 48, 128):
    open(f'{sys.argv[1]}/{s}.png', 'wb').write(png(s))

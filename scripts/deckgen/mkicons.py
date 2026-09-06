import zlib, struct, os

def png(path, size, pixels):
    raw = b''.join(b'\x00' + bytes(pixels[y]) for y in range(size))
    def chunk(t, d):
        c = t + d
        return struct.pack('>I', len(d)) + c + struct.pack('>I', zlib.crc32(c) & 0xffffffff)
    hdr = struct.pack('>IIBBBBB', size, size, 8, 6, 0, 0, 0)  # RGBA
    with open(path, 'wb') as f:
        f.write(b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', hdr) + chunk(b'IDAT', zlib.compress(raw, 9)) + chunk(b'IEND', b''))

def build(size):
    bg = (16, 18, 21)
    ink = (240, 241, 243)
    accent = (77, 148, 255)
    px = [[0]*(size*4) for _ in range(size)]
    r = int(size*0.22)  # corner radius
    for y in range(size):
        for x in range(size):
            # rounded square mask
            cx = min(max(x, r), size-1-r); cy = min(max(y, r), size-1-r)
            inside = ((x-cx)**2 + (y-cy)**2) <= r*r
            i = x*4
            if not inside:
                px[y][i:i+4] = [0,0,0,0]; continue
            px[y][i:i+4] = list(bg) + [255]
    # three sound bars, centre weighted, plus one accent bar
    bars = [(0.26, 0.30), (0.44, 0.62), (0.62, 0.42), (0.80, 0.22)]
    w = max(2, int(size*0.075))
    for n,(fx, h) in enumerate(bars):
        bx = int(size*fx) - w//2
        bh = int(size*h)
        by = (size - bh)//2
        col = accent if n == 1 else ink
        rad = w//2
        for y in range(by, by+bh):
            for x in range(bx, bx+w):
                if 0 <= x < size and 0 <= y < size:
                    # round the bar ends
                    if y < by+rad:
                        if (x-(bx+w/2))**2 + (y-(by+rad))**2 > rad*rad: continue
                    if y > by+bh-rad:
                        if (x-(bx+w/2))**2 + (y-(by+bh-rad))**2 > rad*rad: continue
                    if px[y][x*4+3] == 0: continue
                    px[y][x*4:x*4+4] = list(col) + [255]
    return px

os.makedirs('icons', exist_ok=True)
for s, name in [(192,'icon-192.png'), (512,'icon-512.png'), (180,'apple-touch-icon.png')]:
    png('icons/'+name, s, build(s))
    print(name, os.path.getsize('icons/'+name), 'bytes')

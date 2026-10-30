# python3 compose.py before.png after.png out.png "title" bone|obsidian [scale]
import sys
from PIL import Image, ImageDraw, ImageFont
b, a, out, title, theme = sys.argv[1:6]
scale = float(sys.argv[6]) if len(sys.argv) > 6 else 1.0
FONT = '/home/alan/.local/state/beeline/corners/cf8ffb2b-4d7e-40dd-9844-6452ba9889b0/apps/mobile/sources/assets/fonts/SpaceGrotesk-Medium.ttf'
bg, fg, quiet = (('#F3EEE4', '#1E1A16', '#6F665C') if theme == 'bone' else ('#140D18', '#F1EBE3', '#A39A90'))
imgs = [Image.open(p).convert('RGB') for p in (b, a)]
if scale != 1.0: imgs = [i.resize((int(i.width * scale), int(i.height * scale)), Image.LANCZOS) for i in imgs]
pad, head, sub = 40, 110, 70
w = max(i.width for i in imgs); h = max(i.height for i in imgs)
canvas = Image.new('RGB', (pad * 3 + w * 2, head + sub + h + pad), bg)
d = ImageDraw.Draw(canvas)
d.text((pad, 34), title, fill=fg, font=ImageFont.truetype(FONT, 44))
for n, (img, label) in enumerate(zip(imgs, ('Before · main fe39a63', 'After · this branch'))):
    x = pad + n * (w + pad)
    d.text((x, head + 12), label, fill=quiet, font=ImageFont.truetype(FONT, 34))
    canvas.paste(img, (x, head + sub))
    d.rectangle([x - 1, head + sub - 1, x + img.width, head + sub + img.height], outline=quiet, width=2)
canvas.save(out, optimize=True)
print(out, canvas.size)

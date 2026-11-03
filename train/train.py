#!/usr/bin/env python3
"""Trains the screen classifier and compares it with the old "web site" share.
usage: train.py <data dir> <old model> <new model out> [own screens dir]
A class's folder counts as a screen if its name starts with "screen"; `face` isn't used."""
import glob, hashlib, os, random, sys
import numpy as np, onnx, onnxruntime as ort, timm, torch
from onnxconverter_common import float16
from PIL import Image, ImageEnhance

data, old_path, out_path = sys.argv[1:4]
own = sys.argv[4] if len(sys.argv) > 4 else None
SIZE, EPOCHS, BATCH = 224, 10, 32
MEAN, STD = np.array([0.485, 0.456, 0.406], 'f'), np.array([0.229, 0.224, 0.225], 'f')
device = 'mps' if torch.backends.mps.is_available() else 'cpu'

def held_out(path): return int(hashlib.sha1(os.path.basename(path).split('-')[0].encode()).hexdigest(), 16) % 100 < 20

def load(path, grow=False):
    img = Image.open(path).convert('RGB')
    if grow:
        w, h = img.size
        share = random.uniform(0.6, 1)
        cw, ch = int(w * share), int(h * share)
        x, y = random.randint(0, w - cw), random.randint(0, h - ch)
        img = img.crop((x, y, x + cw, y + ch))
        img = ImageEnhance.Brightness(img).enhance(random.uniform(0.85, 1.15))
    return np.asarray(img.resize((SIZE, SIZE), Image.BILINEAR), 'f') / 255

def tensor(pixels): return ((pixels - MEAN) / STD).transpose(2, 0, 1)

def pale(pixels): return (pixels.mean(2) > 0.75).mean() >= 0.5   # What the pixel checks would pass on, roughly.

items = []
for folder in sorted(glob.glob(f'{data}/*/')):
    name = os.path.basename(folder.rstrip('/'))
    if name == 'face': continue
    for path in glob.glob(f'{folder}*'):
        try:
            Image.open(path).verify()
            items.append((path, name, int(name.startswith('screen'))))
        except Exception:
            pass
train = [i for i in items if not held_out(i[0])]
val = [i for i in items if held_out(i[0])]
print(f'train {len(train)}, held out {len(val)}, screens {sum(i[2] for i in items)}', flush=True)

class Set(torch.utils.data.Dataset):
    def __len__(self): return len(train)
    def __getitem__(self, i):
        path, _, label = train[i]
        return torch.from_numpy(tensor(load(path, True)).copy()), label

model = timm.create_model('mobilenetv4_conv_small.e2400_r224_in1k', pretrained=True, num_classes=2).to(device)
head = list(model.get_classifier().parameters())
for p in model.parameters(): p.requires_grad = False
for p in head: p.requires_grad = True
weights = [1 / max(1, sum(i[2] == c for i in train)) for c in (0, 1)]
sampler = torch.utils.data.WeightedRandomSampler([weights[i[2]] for i in train], len(train))
loader = torch.utils.data.DataLoader(Set(), BATCH, sampler=sampler, num_workers=0)
loss_of = torch.nn.CrossEntropyLoss(label_smoothing=0.05)
for epoch in range(EPOCHS):
    if epoch == 2:
        for p in model.parameters(): p.requires_grad = True
    lr = 1e-3 if epoch < 2 else 2e-4 * (1 - (epoch - 2) / (EPOCHS - 2)) + 1e-5
    optim = torch.optim.AdamW([p for p in model.parameters() if p.requires_grad], lr, weight_decay=0.01) if epoch < 3 else optim
    for g in optim.param_groups: g['lr'] = lr
    model.train()
    total = 0
    for x, y in loader:
        loss = loss_of(model(x.to(device)), y.to(device))
        optim.zero_grad(); loss.backward(); optim.step()
        total += loss.item() * len(y)
    print(f'epoch {epoch}: loss {total / len(train):.3f}', flush=True)

model.eval().cpu()
torch.onnx.export(model, torch.zeros(1, 3, SIZE, SIZE), f'{out_path}.full', input_names=['pixels'], output_names=['logits'], opset_version=17, dynamo=False)
small = float16.convert_float_to_float16(onnx.load(f'{out_path}.full'), keep_io_types=True)
onnx.save(small, out_path)
os.remove(f'{out_path}.full')
print('model MB', round(os.path.getsize(out_path) / 1e6, 1))

def softmax(x): return np.exp(x - x.max(-1, keepdims=True)) / np.exp(x - x.max(-1, keepdims=True)).sum(-1, keepdims=True)
new, old = ort.InferenceSession(out_path), ort.InferenceSession(old_path)
def scores(path):
    pixels = load(path)
    x = tensor(pixels)[None]
    return softmax(new.run(None, {new.get_inputs()[0].name: x})[0])[0, 1], softmax(old.run(None, {old.get_inputs()[0].name: x})[0])[0, 916], pale(pixels)

rows = [(name, label, *scores(path)) for path, name, label in val]
pick = sorted(r[2] for r in rows if r[1])
cut = float(pick[int(len(pick) * 0.03)]) if pick else 0.5   # Keeps 97% of held-out screens.
print('threshold', round(cut, 3))
for label, keep in (('all', lambda r: True), ('pale only', lambda r: r[4])):
    print(f'--- {label}: class, count, new yes, old yes')
    for name in sorted({r[0] for r in rows}):
        got = [r for r in rows if r[0] == name and keep(r)]
        print(f'{name:12} {len(got):4} {sum(r[2] >= cut for r in got):4} {sum(r[3] >= 0.1 for r in got):4}')
if own:
    for path in sorted(glob.glob(f'{own}/*.png')):
        print(os.path.basename(path), [round(float(v), 3) for v in scores(path)[:2]])

# /// script
# requires-python = ">=3.12"
# dependencies = ["torch", "torchvision", "transformers<5", "pillow", "numpy", "timm", "einops", "kornia", "accelerate"]
# ///
import sys
from pathlib import Path

import numpy as np
import torch
from PIL import Image
from transformers import AutoModelForImageSegmentation, Swin2SRForImageSuperResolution, Swin2SRImageProcessor, pipeline

source = Path(sys.argv[1])
out = Path(sys.argv[2])
out.mkdir(parents=True, exist_ok=True)
device = "cuda" if torch.cuda.is_available() else "cpu"
print("device", device, flush=True)
image = Image.open(source).convert("RGB")

depth = pipeline("depth-estimation", model="depth-anything/Depth-Anything-V2-Small-hf", device=device)
result = depth(image)
d = np.array(result["predicted_depth"].squeeze().cpu(), dtype=np.float32)
d = (d - d.min()) / (d.max() - d.min())
Image.fromarray((d * 65535).astype(np.uint16)).resize(image.size, Image.BICUBIC).save(out / "depth16.png")
Image.fromarray((d * 255).astype(np.uint8)).resize(image.size, Image.BICUBIC).save(out / "depth.png")
print("depth done", flush=True)
del depth
torch.cuda.empty_cache()

model = AutoModelForImageSegmentation.from_pretrained("ZhengPeng7/BiRefNet", trust_remote_code=True).to(device).eval().half()
from torchvision import transforms
prep = transforms.Compose([transforms.Resize((1024, 1024)), transforms.ToTensor(), transforms.Normalize([0.485, 0.456, 0.406], [0.229, 0.224, 0.225])])
with torch.no_grad():
    pred = model(prep(image).unsqueeze(0).to(device).half())[-1].sigmoid().float().cpu()[0, 0]
Image.fromarray((pred.numpy() * 255).astype(np.uint8)).resize(image.size, Image.BICUBIC).save(out / "matte.png")
print("matte done", flush=True)
del model
torch.cuda.empty_cache()

processor = Swin2SRImageProcessor()
sr = Swin2SRForImageSuperResolution.from_pretrained("caidas/swin2SR-realworld-sr-x4-64-bsrgan-psnr").to(device).eval()
tile = 256
w, h = image.size
scale = 4
canvas = np.zeros((h * scale, w * scale, 3), dtype=np.float32)
weight = np.zeros((h * scale, w * scale, 1), dtype=np.float32)
pad = 16
for y in range(0, h, tile):
    for x in range(0, w, tile):
        x0, y0 = max(0, x - pad), max(0, y - pad)
        x1, y1 = min(w, x + tile + pad), min(h, y + tile + pad)
        crop = image.crop((x0, y0, x1, y1))
        inputs = processor(crop, return_tensors="pt").to(device)
        with torch.no_grad():
            o = sr(**inputs).reconstruction.squeeze().clamp(0, 1).cpu().numpy()
        o = np.moveaxis(o, 0, -1)[: (y1 - y0) * scale, : (x1 - x0) * scale]
        canvas[y0 * scale : y1 * scale, x0 * scale : x1 * scale] += o
        weight[y0 * scale : y1 * scale, x0 * scale : x1 * scale] += 1
canvas /= np.maximum(weight, 1)
big = Image.fromarray((canvas * 255).round().astype(np.uint8))
big.resize((w * 2, h * 2), Image.LANCZOS).save(out / "plate@2x.png")
print("upscale done", flush=True)

import { CanvasTexture, RepeatWrapping, SRGBColorSpace } from "three/webgpu";

export function machinedFinish() {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 512;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("The engine requires a 2D canvas");
  let seed = 50421;
  function random() {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  }
  context.fillStyle = "#ecdebb";
  context.fillRect(0, 0, 512, 512);
  for (let i = 0; i < 370; i++) {
    const x = random() * 512, y = random() * 512, r = 1 + 44 * random() ** 2;
    const stain = context.createRadialGradient(x, y, 0, x, y, r);
    stain.addColorStop(0, i % 4 ? "#594a355c" : "#41615b8f");
    stain.addColorStop(1, "#47443400");
    context.fillStyle = stain;
    context.fillRect(x-r, y-r, 2*r, 2*r);
  }
  for (let i = 0; i < 20000; i++) {
    const x = random() * 512, y = random() * 512;
    context.fillStyle = i % 3 ? "#3f33202e" : "#fff8dd59";
    context.fillRect(x, y, 1 + random() ** 4 * 83, .3 + random() * .7);
  }
  for (let i = 0; i < 110; i++) {
    const x = random()*512, y = random()*512;
    context.beginPath();
    context.moveTo(x,y);
    context.lineTo(x + random()*38, y - random()*16);
    context.strokeStyle = "#fff9dc8c";
    context.lineWidth = .8;
    context.stroke();
  }
  const color = new CanvasTexture(canvas);
  color.wrapS = color.wrapT = RepeatWrapping;
  const relief = color.clone();
  color.colorSpace = SRGBColorSpace;
  return { color, relief };
}

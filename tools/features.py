"""Empreintes visuelles des cartes (doit rester identique à scan.js)."""
import numpy as np
from PIL import Image

GW, GH = 8, 11          # grille de couleurs (carte entière)
AW, AH = 14, 12         # grille de l illustration
ART = (4, 8, 60, 44)    # x0, y0, x1, y1 de l illustration dans l image 64x88


def to_rgb(img):
    """Les PNG de TCGdex ont des coins transparents : on les pose sur du gris."""
    img = img.convert("RGBA")
    bg = Image.new("RGBA", img.size, (128, 128, 128, 255))
    return Image.alpha_composite(bg, img).convert("RGB")


def small(img):
    """Image PIL -> tableau float 88x64x3 (moyenne par blocs 4x4 d'un 256x352)."""
    a = np.asarray(to_rgb(img).resize((256, 352), Image.BILINEAR), dtype=np.float32)
    return a.reshape(88, 4, 64, 4, 3).mean(axis=(1, 3))


def block(a, gw, gh):
    h, w = a.shape[:2]
    return a.reshape(gh, h // gh, gw, w // gw, -1).mean(axis=(1, 3))


def norm(v):
    v = v - v.mean()
    s = np.sqrt((v * v).mean()) + 1e-6
    return v / s


def feature(img):
    a = small(img)
    col = block(a, GW, GH)                       # 11x8x3
    col = col - col.reshape(-1, 3).mean(0)        # balance des blancs
    col = norm(col.reshape(-1))
    x0, y0, x1, y1 = ART
    art = a[y0:y1, x0:x1].mean(axis=2)            # 40x56 gris
    g = block(art[..., None], AW, AH)[..., 0]     # 12x16
    gx = norm((g[:, 1:] - g[:, :-1]).reshape(-1))
    gy = norm((g[1:, :] - g[:-1, :]).reshape(-1))
    return np.concatenate([col, 0.8 * gx, 0.8 * gy]).astype(np.float32)


DIM = GW * GH * 3 + AH * (AW - 1) + (AH - 1) * AW

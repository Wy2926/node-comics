"""Geometry and width limits shared by recognition and color extraction."""
OCR_IMAGE_SHAPE = (3, 48, 320)
OCR_MAX_WIDTH = 3200


def valid_crop(image):
    return (image is not None and image.size > 0
            and image.shape[1] * OCR_IMAGE_SHAPE[1] <= image.shape[0] * OCR_MAX_WIDTH)


def short_crop(image):
    return image.shape[1] * OCR_IMAGE_SHAPE[1] <= image.shape[0] * OCR_IMAGE_SHAPE[2]


def paragraph_box(box, width, height):
    left, top, right, bottom = map(int, box)
    return max(0, left), max(0, top), min(width, right), min(height, bottom)

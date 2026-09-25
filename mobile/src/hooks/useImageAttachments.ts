import { useState } from 'react'

export type Img = { base64: string; mediaType: string }

const MAX_IMAGES = 4

/** the text the desktop needs for an image-only turn — it skips empty prompts */
export const IMAGE_ONLY_PROMPT = 'See the attached image.'

/** Photos are resized on-device (max 1600px, JPEG) — a raw 12MP capture is a
 *  ~7MB JSON frame through the relay; this keeps it a few hundred KB. */
async function fileToImage(file: File): Promise<Img> {
  const bmp = await createImageBitmap(file)
  const scale = Math.min(1, 1600 / Math.max(bmp.width, bmp.height))
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(bmp.width * scale)
  canvas.height = Math.round(bmp.height * scale)
  canvas.getContext('2d')!.drawImage(bmp, 0, 0, canvas.width, canvas.height)
  const dataUrl = canvas.toDataURL('image/jpeg', 0.82)
  return { base64: dataUrl.split(',')[1], mediaType: 'image/jpeg' }
}

export function useImageAttachments(): {
  images: Img[]
  pick: (files: FileList | null) => Promise<void>
  remove: (index: number) => void
  clear: () => void
} {
  const [images, setImages] = useState<Img[]>([])
  return {
    images,
    pick: async (files) => {
      if (!files?.length) return
      const imgs = await Promise.all([...files].slice(0, MAX_IMAGES).map(fileToImage))
      setImages((prev) => [...prev, ...imgs].slice(0, MAX_IMAGES))
    },
    remove: (index) => setImages((p) => p.filter((_, j) => j !== index)),
    clear: () => setImages([])
  }
}

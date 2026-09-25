import type { JSX } from 'react'
import { Icon } from '@shared/icons'
import type { Img } from '../hooks/useImageAttachments'

export function AttachButton({
  onPick
}: {
  onPick: (files: FileList | null) => Promise<void>
}): JSX.Element {
  return (
    <label className="attach-btn" aria-label="Attach images">
      <Icon name="paperclip" size={18} />
      <input
        type="file"
        accept="image/*"
        multiple
        hidden
        onChange={(e) => {
          void onPick(e.target.files)
          e.target.value = ''
        }}
      />
    </label>
  )
}

export function PendingImages({
  images,
  onRemove
}: {
  images: Img[]
  onRemove: (index: number) => void
}): JSX.Element | null {
  if (images.length === 0) return null
  return (
    <div className="pending-images">
      {images.map((img, i) => (
        <span key={i} className="pending-image">
          <img src={`data:${img.mediaType};base64,${img.base64}`} alt="" />
          <button className="pending-image-x" onClick={() => onRemove(i)}>
            ×
          </button>
        </span>
      ))}
    </div>
  )
}

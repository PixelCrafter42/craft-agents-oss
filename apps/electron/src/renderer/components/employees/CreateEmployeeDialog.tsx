import * as React from 'react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useRegisterModal } from '@/context/ModalContext'

interface CreateEmployeeDialogProps {
  open: boolean
  onCancel: () => void
  onSubmit: (name: string) => void
}

export function CreateEmployeeDialog({ open, onCancel, onSubmit }: CreateEmployeeDialogProps) {
  const [name, setName] = React.useState('')

  useRegisterModal(open, onCancel)

  React.useEffect(() => {
    if (open) setName('')
  }, [open])

  const trimmed = name.trim()
  const canSubmit = trimmed.length > 0

  const handleSubmit = () => {
    if (!canSubmit) return
    onSubmit(trimmed)
  }

  return (
    <Dialog open={open} onOpenChange={(isOpen) => !isOpen && onCancel()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>New employee</DialogTitle>
        </DialogHeader>

        <div className="pt-2">
          <Input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Employee name"
            onKeyDown={(e) => {
              if (e.key === 'Enter' && canSubmit) {
                e.preventDefault()
                handleSubmit()
              }
            }}
          />
        </div>

        <DialogFooter className="gap-2 sm:gap-0">
          <Button variant="outline" onClick={onCancel}>
            Cancel
          </Button>
          <Button disabled={!canSubmit} onClick={handleSubmit}>
            Create
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

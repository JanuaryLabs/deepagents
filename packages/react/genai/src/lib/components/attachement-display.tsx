import { XIcon } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';

export function AttachmentsDisplay(props: {
  attachments: string[];
  onRemoveAttachment: (index: number) => void;
}) {
  return (
    <AnimatePresence>
      {props.attachments.length > 0 && (
        <motion.div
          className="flex flex-wrap gap-2 overflow-hidden pb-3"
          initial={{ opacity: 0, scaleY: 0 }}
          animate={{ opacity: 1, scaleY: 1 }}
          exit={{ opacity: 0, scaleY: 0 }}
          style={{ transformOrigin: 'top' }}
        >
          {props.attachments.map((file, index) => (
            <motion.div
              key={`attachment-${file}-${index}`}
              className="bg-primary/5 text-muted-foreground flex items-center gap-2 rounded-lg px-3 py-1.5 text-xs"
              initial={{ opacity: 0, scale: 0.9 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.9 }}
            >
              <span>{file}</span>
              <button
                onClick={() => props.onRemoveAttachment(index)}
                className="text-muted-foreground hover:text-foreground transition-colors"
              >
                <XIcon className="size-3" />
              </button>
            </motion.div>
          ))}
        </motion.div>
      )}
    </AnimatePresence>
  );
}

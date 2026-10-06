import type { ComponentProps } from "react";

type PortableImageProps = ComponentProps<"img"> & { unoptimized?: boolean; priority?: boolean; fill?: boolean };

export default function Image({ unoptimized: _unoptimized, priority: _priority, fill: _fill, ...props }: PortableImageProps) {
  return <img {...props} />;
}

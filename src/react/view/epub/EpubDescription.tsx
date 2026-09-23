import { ReactNode } from 'react';

export default function EpubDescription({ description }: { description: string }): ReactNode {
    return <div className="description">{description}</div>;
}

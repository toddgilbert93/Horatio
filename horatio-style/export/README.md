# Bust viewer export

Drop-in React Three Fiber bust for Electron / React hosts. Tuned for **≤300×300px**.

## Peer dependencies

```bash
npm install three @react-three/fiber @react-three/drei
```

Requires React 18+.

## Usage

Copy the `export/` folder into your app, then:

```tsx
import { BustViewer } from './export'

<div style={{ width: 200, height: 200 }}>
  <BustViewer rotating={isActive} />
</div>
```

### Props

| Prop | Default | Notes |
|------|---------|--------|
| `rotating` | `true` | Gate with an app event when ready |
| `speed` | `0.35` | Y-axis radians / second |
| `materialId` | `'bone'` | `'plaster'` \| `'bone'` \| `'bronze'` |
| `modelUrl` | bundled `bust1.glb` | Override if you serve the GLB yourself |

Background is `#041300` to match the host app.

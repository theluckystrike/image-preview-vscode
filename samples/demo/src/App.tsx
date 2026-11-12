// Sample for Image Preview & Image Hover: every line below names an image.
// Hover a path to see the image, its type, pixel size and file size.
import logo from '@/assets/logo.svg';
import photo from './assets/photo.jpg';
import avatar from '@assets/avatar.gif';

const hero = 'assets/hero image.png';
const banner = '/banner.png'; // served from public/
const icon = new URL('./assets/icon.webp', import.meta.url).href;
const modern = require('./assets/photo.avif');
const dot = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAAAgUlEQVR42u3awQ2AIBAEQAqjdluDEgCFXPBmEt9L9iW6pQAATGpPbaPnt/kz4ScPEZq/En7iEKH5b8J3HiI0/0v4jkNE5ytAAQpQgAIUoIDEBaR/E3QXcBv0PQAAAACysw+wD7APsA/wY0QBClCAAhSgAAXYB9gH2AfYB9gHAMC1Ou+0jYYPqcMhAAAAAElFTkSuQmCC';
const remote = 'https://example.com/never-downloaded.png';
const missing = './assets/old-logo.png';

export function App() {
  return (
    <main>
      <img src={logo} alt="Logo" width={120} />
      <img src="/banner.png" srcSet="/banner.png 1x, ./assets/hero%20image.png 2x" alt="Banner" />
      <img src={photo} alt="Dusk" />
    </main>
  );
}

import '@testing-library/jest-dom';

if (typeof URL.createObjectURL !== 'function') {
  let counter = 0;
  URL.createObjectURL = () => {
    counter += 1;
    return `blob:http://localhost/mock-blob-${counter}`;
  };
}

if (typeof URL.revokeObjectURL !== 'function') {
  URL.revokeObjectURL = () => {};
}

if (typeof window !== 'undefined' && window.URL) {
  if (typeof window.URL.createObjectURL !== 'function') {
    window.URL.createObjectURL = URL.createObjectURL;
  }
  if (typeof window.URL.revokeObjectURL !== 'function') {
    window.URL.revokeObjectURL = URL.revokeObjectURL;
  }
}

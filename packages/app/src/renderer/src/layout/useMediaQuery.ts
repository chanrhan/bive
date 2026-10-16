import { useEffect, useState } from 'react';

const matches = (query: string): boolean =>
  typeof window.matchMedia === 'function' && window.matchMedia(query).matches;

/** 미디어 쿼리 일치 여부를 따라간다. */
export const useMediaQuery = (query: string): boolean => {
  const [value, setValue] = useState(() => matches(query));
  useEffect(() => {
    const list = window.matchMedia(query);
    const update = (): void => setValue(list.matches);
    update();
    list.addEventListener('change', update);
    return () => list.removeEventListener('change', update);
  }, [query]);
  return value;
};

/** `:root`의 CSS 변수 값 (토큰). 없으면 fallback. */
export const readToken = (name: string, fallback: string): string => {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value === '' ? fallback : value;
};

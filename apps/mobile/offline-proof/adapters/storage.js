const values = new Map();
export const storage = {
  getItem: async (key) => values.get(key) ?? null,
  setItem: async (key, value) => {
    values.set(key, value);
  },
  removeItem: async (key) => {
    values.delete(key);
  },
};
export default storage;
export class MMKV {
  getString = (key) => values.get(key);
  set = (key, value) => values.set(key, value);
  delete = (key) => values.delete(key);
  getAllKeys = () => [...values.keys()];
  contains = (key) => values.has(key);
}

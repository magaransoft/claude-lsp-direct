export function greet(name: string): string {
  return `hello, ${name}`;
}

export function add(a: number, b: number): number {
  return a + b;
}

export class Counter {
  private value: number;

  constructor(start: number = 0) {
    this.value = start;
  }

  increment(by: number = 1): number {
    this.value += by;
    return this.value;
  }
}

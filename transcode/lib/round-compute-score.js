export const smallest_denominator = 8;

export function getMinimum () {
  return 1 / smallest_denominator;
}
export default function roundComputeScore (number) {
  // Round the number to the nearest 1/8th with a minimum of 1 factor
  return Math.max(Math.round(number * smallest_denominator) / smallest_denominator, getMinimum());
}

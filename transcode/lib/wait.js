// async/await compatible timeout

export default function wait(sec) {
  return new Promise((resolve) => {
    setTimeout(resolve, sec * 1000);
  });
}

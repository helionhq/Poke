import { Redirect, useLocalSearchParams } from "expo-router";

/** poke://thread?message=… (push notifications, shares): the thread, scrolled to that message. */
export default function ThreadLink() {
  const { message } = useLocalSearchParams<{ message?: string }>();
  return <Redirect href={message ? { pathname: "/", params: { message } } : "/"} />;
}

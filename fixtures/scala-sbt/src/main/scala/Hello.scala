object Hello:
  def greet(name: String): String = s"Hello, $name!"

  @main def run(): Unit =
    println(greet("world"))

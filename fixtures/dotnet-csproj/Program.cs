namespace Hello;

public static class Program
{
    public static string Greet(string name) => $"Hello, {name}!";

    public static void Main(string[] args)
    {
        System.Console.WriteLine(Greet(args.Length > 0 ? args[0] : "world"));
    }
}

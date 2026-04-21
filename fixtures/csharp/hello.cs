namespace Fixture;

public static class Greeter
{
    public static string Greet(string name) => $"hello, {name}";

    public static int Add(int a, int b) => a + b;
}

public class Counter
{
    private int _value;

    public Counter(int start = 0) => _value = start;

    public int Increment(int by = 1)
    {
        _value += by;
        return _value;
    }
}
